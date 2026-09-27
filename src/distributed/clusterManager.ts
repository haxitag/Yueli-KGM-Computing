/**
 * 分布式集群管理器
 * 借鉴 VMLX 的多 Mac Pipeline Parallel + 自动发现技术
 * 使用真实 mDNS/Bonjour 实现节点自动发现和能力评分选举
 */

import bonjour, { type RemoteService } from 'bonjour';

export interface NodeInfo {
  id: string;
  host: string;
  port: number;
  gpuCount: number;
  ramGb: number;
  cpuCores: number;
  status: 'online' | 'offline' | 'busy';
  capabilities: string[];
  score?: number;
  service?: RemoteService;
}

export interface ClusterConfig {
  discoveryTimeout: number;
  electionInterval: number;
  maxNodes: number;
  serviceName?: string;
}

type BonjourInstance = ReturnType<typeof bonjour>;
type BrowserInstance = ReturnType<BonjourInstance['find']>;

export class DistributedClusterManager {
  private nodes: Map<string, NodeInfo> = new Map();
  private coordinatorId: string | null = null;
  private config: ClusterConfig;
  private discoveryInterval: ReturnType<typeof setInterval> | null = null;
  private bonjourInstance: BonjourInstance | null = null;
  private browser: BrowserInstance | null = null;
  private discoveredServices: Map<string, RemoteService> = new Map();

  constructor(config?: Partial<ClusterConfig>) {
    this.config = {
      discoveryTimeout: config?.discoveryTimeout || 5000,
      electionInterval: config?.electionInterval || 30000,
      maxNodes: config?.maxNodes || 8,
      serviceName: config?.serviceName || '_kgm._tcp.local'
    };
  }

  startDiscovery(): void {
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
    }

    this.bonjourInstance = bonjour();

    const serviceType = this.config.serviceName?.split('.')[0] || '_kgm';
    this.browser = this.bonjourInstance.find({
      type: serviceType,
      protocol: 'tcp'
    });

    this.browser.on('up', (service: RemoteService) => {
      this.handleServiceUp(service);
    });

    this.browser.on('down', (service: RemoteService) => {
      this.handleServiceDown(service);
    });

    this.discoveryInterval = setInterval(async () => {
      await this.electCoordinator();
    }, this.config.electionInterval);

    setTimeout(() => this.electCoordinator(), 1000);
  }

  stopDiscovery(): void {
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
    }

    if (this.browser) {
      this.browser.stop();
      this.browser = null;
    }

    if (this.bonjourInstance) {
      this.bonjourInstance.destroy();
      this.bonjourInstance = null;
    }
  }

  private handleServiceUp(service: RemoteService): void {
    const serviceId = this.getServiceId(service);
    const nodeInfo = this.parseServiceInfo(service);

    this.discoveredServices.set(serviceId, service);

    this.nodes.set(serviceId, {
      ...nodeInfo,
      status: 'online',
      service
    });

    console.log(`Node discovered: ${serviceId} at ${service.host}:${service.port}`);
    this.electCoordinator();
  }

  private handleServiceDown(service: RemoteService): void {
    const serviceId = this.getServiceId(service);

    const node = this.nodes.get(serviceId);
    if (node) {
      node.status = 'offline';
      console.log(`Node offline: ${serviceId}`);
    }

    this.discoveredServices.delete(serviceId);

    if (this.coordinatorId === serviceId) {
      this.electCoordinator();
    }
  }

  private getServiceId(service: RemoteService): string {
    return service.name || `${service.host}-${service.port}`;
  }

  private parseServiceInfo(service: RemoteService): Omit<NodeInfo, 'status' | 'service'> {
    const txt = service.txt || {};

    return {
      id: this.getServiceId(service),
      host: service.host || 'localhost',
      port: service.port || 8080,
      gpuCount: parseInt(String(txt.gpuCount || '0'), 10) || 1,
      ramGb: parseInt(String(txt.ramGb || '0'), 10) || 16,
      cpuCores: parseInt(String(txt.cpuCores || '0'), 10) || 4,
      capabilities: txt.capabilities ? String(txt.capabilities).split(',') : ['llm'],
      score: undefined
    };
  }

  async discoverNodes(): Promise<NodeInfo[]> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(Array.from(this.nodes.values()).filter(n => n.status === 'online'));
      }, this.config.discoveryTimeout);

      if (this.nodes.size > 0) {
        clearTimeout(timeout);
        resolve(Array.from(this.nodes.values()).filter(n => n.status === 'online'));
      }
    });
  }

  async electCoordinator(): Promise<string | null> {
    const onlineNodes = Array.from(this.nodes.values()).filter(n => n.status === 'online');

    if (onlineNodes.length === 0) {
      this.coordinatorId = null;
      return null;
    }

    const scoredNodes = onlineNodes.map(node => ({
      ...node,
      score: this.calculateCapabilityScore(node)
    }));

    scoredNodes.sort((a, b) => (b.score || 0) - (a.score || 0));
    const coordinator = scoredNodes[0];
    const oldCoordinatorId = this.coordinatorId;
    this.coordinatorId = coordinator.id;

    scoredNodes.forEach(node => {
      const existing = this.nodes.get(node.id);
      if (existing) {
        existing.score = node.score;
      }
    });

    if (oldCoordinatorId !== this.coordinatorId) {
      console.log(`Coordinator changed: ${oldCoordinatorId} -> ${this.coordinatorId}`);
    }

    return coordinator.id;
  }

  calculateCapabilityScore(node: NodeInfo): number {
    let score = 0;

    score += node.gpuCount * 10;
    score += node.ramGb;
    score += node.cpuCores * 0.5;
    score += node.capabilities.length * 2;

    if (node.status === 'online') {
      score += 5;
    }

    return score;
  }

  advertiseService(options: {
    name: string;
    port: number;
    gpuCount?: number;
    ramGb?: number;
    cpuCores?: number;
    capabilities?: string[];
  }): void {
    if (!this.bonjourInstance) {
      this.bonjourInstance = bonjour();
    }

    const serviceType = this.config.serviceName?.split('.')[0] || '_kgm';

    const service = this.bonjourInstance.publish({
      name: options.name,
      type: serviceType,
      protocol: 'tcp',
      port: options.port,
      txt: {
        gpuCount: String(options.gpuCount || 1),
        ramGb: String(options.ramGb || 16),
        cpuCores: String(options.cpuCores || 4),
        capabilities: (options.capabilities || ['llm']).join(',')
      }
    });

    service.on('error', (err: Error) => {
      console.warn('Failed to advertise service:', err.message);
    });

    console.log(`Advertising service: ${options.name} on port ${options.port}`);
  }

  getCoordinator(): NodeInfo | null {
    if (!this.coordinatorId) {
      return null;
    }
    return this.nodes.get(this.coordinatorId) || null;
  }

  getNodes(): NodeInfo[] {
    return Array.from(this.nodes.values());
  }

  getSortedNodes(): NodeInfo[] {
    return Array.from(this.nodes.values())
      .filter(n => n.status === 'online')
      .sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  addNode(node: NodeInfo): void {
    this.nodes.set(node.id, node);
  }

  removeNode(nodeId: string): void {
    this.nodes.delete(nodeId);
    if (this.coordinatorId === nodeId) {
      this.electCoordinator();
    }
  }

  getStats(): {
    totalNodes: number;
    onlineNodes: number;
    coordinatorId: string | null;
    avgScore: number;
  } {
    const nodes = Array.from(this.nodes.values());
    const onlineNodes = nodes.filter(n => n.status === 'online');

    return {
      totalNodes: nodes.length,
      onlineNodes: onlineNodes.length,
      coordinatorId: this.coordinatorId,
      avgScore: onlineNodes.length > 0
        ? onlineNodes.reduce((acc, n) => acc + (n.score || 0), 0) / onlineNodes.length
        : 0
    };
  }

  getDiscoveredServices(): RemoteService[] {
    return Array.from(this.discoveredServices.values());
  }
}
