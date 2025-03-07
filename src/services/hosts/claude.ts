import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { restartClaude } from '../../utils/cmd.js';
import { processPackageInfoToBootConfig } from '../../utils/command.js';
import { logger } from '../../utils/logger.js';
import { registrySrv } from '../registry.js';
import {
  MCPServerConfigSource,
  StoragedMCPServer,
  StorageService,
} from '../storage.js';
import {
  ClaudeConfig,
  IHostService,
  MCPServerBootConfig,
  MCPServerMap,
  MCPServerWithStatus,
} from './base.js';

export class ClaudeFileService {
  constructor(private readonly fs: typeof fsp = fsp) {}

  async getClaudeConfig(): Promise<ClaudeConfig | null> {
    try {
      const configPath = ClaudeFileService.getClaudeConfigPath();
      if (!configPath) return null;
      const content = await this.fs.readFile(configPath, 'utf8');
      return JSON.parse(content) as ClaudeConfig;
    } catch {
      logger.error('Claude config not found');
      return null;
    }
  }

  private createDefaultClaudeConfig(): ClaudeConfig {
    return {
      mcpServers: {},
    };
  }

  private stringifyClaudeConfig(config: ClaudeConfig): string {
    return JSON.stringify(config, null, 2);
  }

  async createClaudeConfigFile(): Promise<ClaudeConfig> {
    const defaultConfig = this.createDefaultClaudeConfig();
    const configPath = ClaudeFileService.getClaudeConfigPath();
    if (!configPath) throw new Error('Unsupported platform');
    await this.fs.writeFile(
      configPath,
      this.stringifyClaudeConfig(defaultConfig)
    );
    logger.info('Claude config created');
    return defaultConfig;
  }

  async getOrCreateClaudeConfig(): Promise<ClaudeConfig> {
    const content = await this.getClaudeConfig();
    if (content) {
      return content;
    }
    return await this.createClaudeConfigFile();
  }

  async writeClaudeConfigFile(config: ClaudeConfig): Promise<void> {
    const configPath = ClaudeFileService.getClaudeConfigPath();
    if (!configPath) throw new Error('Unsupported platform');
    await this.fs.writeFile(configPath, this.stringifyClaudeConfig(config));
  }

  async modifyClaudeConfigFile(
    modifier: (config: ClaudeConfig) => Promise<ClaudeConfig> | ClaudeConfig
  ): Promise<ClaudeConfig> {
    const config = await this.getOrCreateClaudeConfig();
    const newConfig = await modifier(config);
    await this.writeClaudeConfigFile(newConfig);
    return newConfig;
  }

  async saveClaudeConfig(config: ClaudeConfig): Promise<void> {
    await this.writeClaudeConfigFile(config);
  }

  static getClaudeConfigPath(): string {
    // process.platform Posible values：
    // 'aix' - IBM AIX
    // 'darwin' - macOS
    // 'freebsd' - FreeBSD
    // 'linux' - Linux
    // 'openbsd' - OpenBSD
    // 'sunos' - SunOS
    // 'win32' - Windows(32-bit or 64-bit)

    const home = os.homedir();

    if (process.platform === 'win32') {
      // Windows Path
      return path.join(
        home,
        'AppData',
        'Roaming', // $env:AppData
        'Claude',
        'claude_desktop_config.json'
      );
    } else if (process.platform === 'darwin') {
      // macOS Path
      return path.join(
        home,
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json'
      );
    } else {
      // Linux/Unix Path
      return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
    }
  }
}

export class ClaudeHostService implements IHostService {
  constructor(
    public readonly fileSrv: ClaudeFileService = new ClaudeFileService(),
    private readonly storageSrv: StorageService = StorageService.getInstance()
  ) {}

  private addMCPServerToConfigJSON(
    config: ClaudeConfig,
    name: string,
    server: MCPServerBootConfig
  ): ClaudeConfig {
    config.mcpServers = config.mcpServers || {};
    if (config.mcpServers[name]) {
      throw new Error('Server already exists');
    }
    config.mcpServers[name] = server;
    return config;
  }

  private removeMCPServerFromConfigJSON(
    config: ClaudeConfig,
    serverName: string
  ): ClaudeConfig {
    config.mcpServers = config.mcpServers || {};
    if (!config.mcpServers[serverName]) {
      throw new Error(`Server ${serverName} not found`);
    }
    delete config.mcpServers[serverName];
    return config;
  }

  async addMCPServer(
    name: string,
    server: MCPServerBootConfig,
    source: MCPServerConfigSource = MCPServerConfigSource.LOCAL
  ): Promise<ClaudeConfig> {
    this.storageSrv.addMCPServers([
      {
        name,
        appConfig: server,
        from: source,
      },
    ]);
    return await this.fileSrv.modifyClaudeConfigFile(config =>
      this.addMCPServerToConfigJSON(config, name, server)
    );
  }

  async removeMCPServer(name: string): Promise<void> {
    // Check if server exists in storage
    const server = this.storageSrv.getMCPServer(name);
    if (!server) {
      throw new Error(`Server ${name} not found`);
    }

    // Remove from storage
    this.storageSrv.removeMCPServer(name);

    // Try to remove from Claude config if it exists (for enabled servers)
    try {
      await this.fileSrv.modifyClaudeConfigFile(config => {
        if (config.mcpServers?.[name]) {
          delete config.mcpServers[name];
        }
        return config;
      });
    } catch (error) {
      // If error occurs while removing from Claude config,
      // we still consider it successful since it's removed from storage
      logger.debug(`Failed to remove from Claude config: ${error}`);
    }
  }

  async getMCPServersInConfig(): Promise<MCPServerMap> {
    const config = await this.fileSrv.getClaudeConfig();
    return config?.mcpServers || {};
  }

  async getAllMCPServersWithStatus(): Promise<MCPServerWithStatus[]> {
    const enabledServers = await this.getMCPServersInConfig();
    let installedServers = this.storageSrv.getAllMCPServers();
    // Add new enabled servers (not in storage)
    const newEnabledServers = Object.entries(enabledServers).reduce(
      (acc, [name, server]) => {
        if (!name) {
          return acc;
        }
        const isEnabled =
          installedServers.some(
            installedServer => installedServer.claudeId === name
          ) ||
          installedServers.some(
            installedServer => installedServer.name === name
          );
        if (!isEnabled) {
          acc = [
            ...acc,
            {
              name,
              claudeId: name,
              appConfig: server,
              from: MCPServerConfigSource.LOCAL,
            },
          ];
        }
        return acc;
      },
      [] as StoragedMCPServer[]
    );
    this.storageSrv.addMCPServers(newEnabledServers);
    installedServers = [...installedServers, ...newEnabledServers];
    return installedServers.map(server => ({
      info: server,
      enabled: !!enabledServers[server.name],
    }));
  }

  async disableMCPServer(name: string): Promise<void> {
    await this.fileSrv.modifyClaudeConfigFile(config => {
      if (!config?.mcpServers?.[name]) {
        throw new Error(`MCP server '${name}' not found`);
      }

      const server = config.mcpServers[name];

      this.storageSrv.addIfNotExistedMCPServer({
        name,
        appConfig: server,
        from: MCPServerConfigSource.LOCAL,
      });

      delete config.mcpServers[name];
      return config;
    });
  }

  async enableMCPServer(name: string): Promise<void> {
    const storaged = this.storageSrv.getMCPServer(name);

    if (!storaged) {
      throw new Error(`MCP server '${name}' not found`);
    }

    await this.fileSrv.modifyClaudeConfigFile(config => {
      if (config?.mcpServers?.[name]) {
        throw new Error(`MCP server '${name}' already exists`);
      }
      config.mcpServers = config.mcpServers || {};
      config.mcpServers[name] = storaged.appConfig;
      return config;
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getDisabledMCPServers(): Promise<{
    [key: string]: StoragedMCPServer;
  }> {
    const servers = await this.getAllMCPServersWithStatus();
    return servers
      .filter(server => !server.enabled)
      .reduce(
        (acc, server) => ({ ...acc, [server.info.name]: server.info }),
        {}
      );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getEnabledMCPServers(): Promise<{
    [key: string]: StoragedMCPServer;
  }> {
    const servers = await this.getAllMCPServersWithStatus();
    return servers
      .filter(server => server.enabled)
      .reduce(
        (acc, server) => ({ ...acc, [server.info.name]: server.info }),
        {}
      );
  }

  public clearAllData(): void {
    this.storageSrv.clear();
  }

  public async restartHostApp(): Promise<void> {
    await restartClaude();
  }

  public async addMCPMSelfMCPServer(): Promise<void> {
    const selfConfig: StoragedMCPServer = {
      name: 'mcpm',
      appConfig: {
        command: 'mcpm',
        args: ['mcp'],
      },
      from: MCPServerConfigSource.SELF,
    };
    this.storageSrv.addMCPServers([selfConfig]);
    await this.fileSrv.modifyClaudeConfigFile(config =>
      this.addMCPServerToConfigJSON(
        config,
        selfConfig.name,
        selfConfig.appConfig
      )
    );
  }

  async getMCPServerWithStatus(
    name: string
  ): Promise<MCPServerWithStatus | null> {
    const enabledServers = await this.getMCPServersInConfig();
    const server = this.storageSrv.getMCPServer(name);

    if (!server) {
      // Check if it exists in enabled servers but not in storage
      const enabledServer = enabledServers[name];
      if (!enabledServer) {
        return null;
      }
      // Add to storage if it exists in Claude config
      const newServer = {
        name,
        claudeId: name,
        appConfig: enabledServer,
        from: MCPServerConfigSource.LOCAL,
      };
      this.storageSrv.addMCPServers([newServer]);
      return {
        info: newServer,
        enabled: true,
      };
    }

    return {
      info: server,
      enabled: !!enabledServers[server.name],
    };
  }

  async installPackage(
    name: string,
    paramValues: Record<string, string>
  ): Promise<void> {
    const packageInfo = await registrySrv.getPackageInfo(name);

    // Validate parameters
    for (const [key] of Object.entries(paramValues)) {
      if (!packageInfo.parameters[key]) {
        throw new Error(`Unknown parameter: ${key}`);
      }
    }

    // Check required parameters
    const missingParams = Object.entries(packageInfo.parameters)
      .filter(([key, info]) => info.required && !paramValues[key])
      .map(([key]) => key);

    if (missingParams.length > 0) {
      throw new Error(
        `Missing required parameters: ${missingParams.join(', ')}`
      );
    }

    if (!packageInfo.commandInfo) {
      throw new Error('Package does not have command info');
    }

    const appConfig = processPackageInfoToBootConfig(
      packageInfo.commandInfo,
      paramValues
    );

    this.storageSrv.addMCPServers([
      {
        name,
        appConfig,
        from: MCPServerConfigSource.REMOTE,
        arguments: paramValues,
      },
    ]);
    await this.fileSrv.modifyClaudeConfigFile(config =>
      this.addMCPServerToConfigJSON(config, name, appConfig)
    );
  }

  async updateMCPServerParams(
    name: string,
    newParamValues: Record<string, string>
  ): Promise<void> {
    // Get existing server
    const server = this.storageSrv.getMCPServer(name);
    if (!server) {
      throw new Error(`Server ${name} not found`);
    }

    // Get package info to validate parameters
    const packageInfo = await registrySrv.getPackageInfo(server.name);
    if (!packageInfo.commandInfo) {
      throw new Error('Package does not have command info');
    }

    // Validate parameters
    for (const [key] of Object.entries(newParamValues)) {
      if (!packageInfo.parameters[key]) {
        throw new Error(`Unknown parameter: ${key}`);
      }
    }

    // Check required parameters
    const missingParams = Object.entries(packageInfo.parameters)
      .filter(([key, info]) => info.required && !newParamValues[key])
      .map(([key]) => key);

    if (missingParams.length > 0) {
      throw new Error(
        `Missing required parameters: ${missingParams.join(', ')}`
      );
    }

    // Process new config
    const appConfig = processPackageInfoToBootConfig(
      packageInfo.commandInfo,
      newParamValues
    );

    // Update storage
    this.storageSrv.addMCPServers([
      {
        ...server,
        appConfig,
        arguments: newParamValues,
      },
    ]);

    // Update Claude config if enabled
    const enabledServers = await this.getMCPServersInConfig();
    if (enabledServers[name]) {
      await this.fileSrv.modifyClaudeConfigFile(config =>
        this.addMCPServerToConfigJSON(config, name, appConfig)
      );
    }
  }
}
