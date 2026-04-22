/**
 * 分布式集群支持
 * 为KGM Computing提供水平扩展和负载均衡能力
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

export interface ClusterConfig {
  /** 集群名称 */
  name: string;
  /** 节点发现方式：static|consul|etcd|k8s */
  discovery: 'static' | 'consul' | 'etcd' | 'k8s';
  /** 集群广播地址 */
  broadcastAddress: string;
  /** 集群广播端口 */
  broadcastPort: number;
  /** 心跳间隔（毫秒） */
  heartbeatInterval: number;
  /** 节点失效超时（毫秒） */
  nodeTimeout: number;
  /** 是否启用领导选举 */
  leaderElection: boolean;
  /** 是否启用数据分片 */
  sharding: boolean;
  /** 总分片数 */
  totalShards: number;
  /** 节点配置 */
  nodes?: ClusterNode[];
}

export interface ClusterNode {
  /** 节点ID */
  id: string;
  /** 节点名称 */
  name: string;
  /** 节点地址 */
  address: string;
  /** 节点端口 */
  port: number;
  /** 节点角色：worker|controller|mixed */
  role: 'worker' | 'controller' | 'mixed';
  /** 分配的切片ID列表 */
  shards: number[];
  /** 节点状态 */
  status: 'online' | 'offline' | 'joining' | 'leaving';
  /** 最后心跳时间 */
  lastHeartbeat: number;
  /** 节点元数据 */
  metadata: Record<string, any>;
}

export interface ClusterMessage {
  /** 消息ID */
  id: string;
  /** 消息类型 */
  type: string;
  /** 发送者节点ID */
  sender: string;
  /** 接收者节点ID（null表示广播） */
  receiver: string | null;
  /** 消息负载 */
  payload: any;
  /** 时间戳 */
  timestamp: number;
  /** TTL（生存时间） */
  ttl: number;
}

export interface ShardMapping {
  /** 分片ID */
  shardId: number;
  /** 主节点ID */
  primaryNode: string;
  /** 备份节点ID列表 */
  replicaNodes: string[];
  /** 分片状态 */
  status: 'active' | 'migrating' | 'unavailable';
}

/**
 * 集群管理器
 */
export class ClusterManager extends EventEmitter {
  private config: ClusterConfig;
  private nodes: Map<string, ClusterNode> = new Map();
  private shardMappings: Map<number, ShardMapping> = new Map();
  private currentNode: ClusterNode | null = null;
  private leaderNode: ClusterNode | null = null;
  private messageQueue: Map<string, ClusterMessage> = new Map();
  private heartbeatTimer?: NodeJS.Timeout;
  private discoveryTimer?: NodeJS.Timeout;
  
  constructor(config: Partial<ClusterConfig> = {}) {
    super();
    
    this.config = {
      name: config.name || 'kgm-cluster',
      discovery: config.discovery || 'static',
      broadcastAddress: config.broadcastAddress || '0.0.0.0',
      broadcastPort: config.broadcastPort || 7946,
      heartbeatInterval: config.heartbeatInterval || 5000,
      nodeTimeout: config.nodeTimeout || 15000,
      leaderElection: config.leaderElection ?? true,
      sharding: config.sharding ?? false,
      totalShards: config.totalShards || 64,
      nodes: config.nodes || [],
    };
    
    // 初始化节点
    if (this.config.discovery === 'static' && this.config.nodes) {
      this.config.nodes.forEach(node => {
        this.nodes.set(node.id, node);
      });
    }
  }
  
  /**
   * 加入集群
   */
  async join(nodeInfo: Omit<ClusterNode, 'id' | 'status' | 'lastHeartbeat'>): Promise<ClusterNode> {
    // 生成节点ID
    const nodeId = randomUUID();
    
    const currentNode: ClusterNode = {
      id: nodeId,
      ...nodeInfo,
      status: 'joining',
      lastHeartbeat: Date.now(),
    };
    
    this.currentNode = currentNode;
    this.nodes.set(nodeId, currentNode);
    
    // 广播加入消息
    await this.broadcastMessage({
      type: 'node.join',
      sender: nodeId,
      receiver: null,
      payload: currentNode,
      timestamp: Date.now(),
      ttl: 30000,
    });
    
    // 如果是第一个节点，自动成为leader
    if (this.config.leaderElection && this.nodes.size === 1) {
      await this.electLeader(nodeId);
    }
    
    currentNode.status = 'online';
    this.nodes.set(nodeId, currentNode);
    
    // 开始心跳
    this.startHeartbeat();
    
    // 开始节点发现
    this.startDiscovery();
    
    // 如果需要分片，分配分片
    if (this.config.sharding) {
      await this.assignShards(nodeId);
    }
    
    console.log(`✅ 节点 ${currentNode.name} (${nodeId}) 已加入集群`);
    
    this.emit('node.join', currentNode);
    
    return currentNode;
  }
  
  /**
   * 离开集群
   */
  async leave(): Promise<void> {
    if (!this.currentNode) {
      throw new Error('Current node not joined');
    }
    
    // 广播离开消息
    await this.broadcastMessage({
      type: 'node.leave',
      sender: this.currentNode.id,
      receiver: null,
      payload: { nodeId: this.currentNode.id },
      timestamp: Date.now(),
      ttl: 30000,
    });
    
    // 如果是leader，触发新的选举
    if (this.currentNode.id === this.leaderNode?.id) {
      this.leaderNode = null;
      await this.triggerLeaderElection();
    }
    
    // 转移当前节点的分片
    if (this.config.sharding) {
      await this.redistributeShards(this.currentNode.id);
    }
    
    // 从节点列表中移除
    this.nodes.delete(this.currentNode.id);
    
    // 停止定时器
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
    }
    
    this.emit('node.leave', this.currentNode);
    
    console.log(`🛑 节点 ${this.currentNode.name} 已离开集群`);
    
    this.currentNode = null;
  }
  
  /**
   * 发送消息到集群
   */
  async sendMessage(message: Omit<ClusterMessage, 'id' | 'sender' | 'timestamp'>): Promise<void> {
    const fullMessage: ClusterMessage = {
      id: randomUUID(),
      sender: this.currentNode!.id,
      timestamp: Date.now(),
      ...message,
    };
    
    if (message.receiver) {
      // 单播消息
      await this.sendToNode(message.receiver, fullMessage);
    } else {
      // 广播消息
      await this.broadcastMessage(fullMessage);
    }
  }
  
  /**
   * 获取集群状态
   */
  getClusterStatus(): {
    nodes: ClusterNode[];
    leader: ClusterNode | null;
    shards: ShardMapping[];
    health: {
      status: 'healthy' | 'degraded' | 'unhealthy';
      onlineNodes: number;
      totalNodes: number;
      shardCoverage: number;
    };
  } {
    const nodeList = Array.from(this.nodes.values());
    const onlineNodes = nodeList.filter(node => node.status === 'online');
    
    // 计算分片覆盖率
    let shardCoverage = 0;
    if (this.config.sharding) {
      const activeShards = Array.from(this.shardMappings.values()).filter(
        shard => shard.status === 'active'
      ).length;
      shardCoverage = activeShards / this.config.totalShards;
    }
    
    // 确定集群健康状态
    let healthStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    
    if (onlineNodes.length === 0) {
      healthStatus = 'unhealthy';
    } else if (onlineNodes.length < nodeList.length) {
      healthStatus = 'degraded';
    }
    
    if (this.config.sharding && shardCoverage < 1) {
      healthStatus = 'degraded';
    }
    
    return {
      nodes: nodeList,
      leader: this.leaderNode,
      shards: Array.from(this.shardMappings.values()),
      health: {
        status: healthStatus,
        onlineNodes: onlineNodes.length,
        totalNodes: nodeList.length,
        shardCoverage,
      },
    };
  }
  
  /**
   * 获取当前节点
   */
  getCurrentNode(): ClusterNode | null {
    return this.currentNode;
  }
  
  /**
   * 获取所有节点
   */
  getNodes(): ClusterNode[] {
    return Array.from(this.nodes.values());
  }
  
  /**
   * 根据分片ID获取负责节点
   */
  getNodeForShard(shardId: number): ClusterNode | null {
    if (!this.config.sharding) {
      return this.currentNode;
    }
    
    const mapping = this.shardMappings.get(shardId);
    if (!mapping || mapping.status !== 'active') {
      return null;
    }
    
    return this.nodes.get(mapping.primaryNode) || null;
  }
  
  /**
   * 获取节点负责的分片列表
   */
  getShardsForNode(nodeId: string): number[] {
    if (!this.config.sharding) return [];
    
    const shards: number[] = [];
    
    for (const [shardId, mapping] of this.shardMappings.entries()) {
      if (mapping.primaryNode === nodeId || mapping.replicaNodes.includes(nodeId)) {
        shards.push(shardId);
      }
    }
    
    return shards;
  }
  
  /**
   * 重新平衡分片
   */
  async rebalanceShards(): Promise<void> {
    if (!this.config.sharding) return;
    
    const onlineNodes = Array.from(this.nodes.values()).filter(
      node => node.status === 'online'
    );
    
    if (onlineNodes.length === 0) return;
    
    // 计算每个节点应该有的分片数
    const shardsPerNode = Math.floor(this.config.totalShards / onlineNodes.length);
    const extraShards = this.config.totalShards % onlineNodes.length;
    
    // 重新分配分片
    const newMappings: Map<number, ShardMapping> = new Map();
    let shardIndex = 0;
    
    for (let i = 0; i < onlineNodes.length; i++) {
      const node = onlineNodes[i];
      const shardCount = shardsPerNode + (i < extraShards ? 1 : 0);
      
      for (let j = 0; j < shardCount; j++) {
        if (shardIndex < this.config.totalShards) {
          // 选择副本节点
          const replicaNodes = onlineNodes
            .filter(n => n.id !== node.id)
            .slice(0, 2) // 最多两个副本
            .map(n => n.id);
          
          newMappings.set(shardIndex, {
            shardId: shardIndex,
            primaryNode: node.id,
            replicaNodes,
            status: 'active',
          });
          
          shardIndex++;
        }
      }
    }
    
    // 执行分片迁移（这里简化处理，实际需要数据迁移）
    const oldMappings = this.shardMappings;
    this.shardMappings = newMappings;
    
    console.log('🔀 分片重新平衡完成');
    this.emit('shards.rebalanced', { old: oldMappings, new: newMappings });
  }
  
  private async sendToNode(nodeId: string, message: ClusterMessage): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (!node || node.status !== 'online') {
      throw new Error(`Node ${nodeId} is not available`);
    }
    
    // 这里应该使用实际的网络传输
    // 为了演示，我们模拟网络传输
    console.log(`📨 发送消息到节点 ${node.name}:`, message.type);
    
    // 存储消息以便后续处理
    this.messageQueue.set(message.id, message);
    
    // 模拟网络延迟
    setTimeout(() => {
      this.handleIncomingMessage(message, node);
    }, 10 + Math.random() * 90); // 10-100ms延迟
  }
  
  private async broadcastMessage(message: Omit<ClusterMessage, 'id' | 'sender' | 'timestamp'>): Promise<void> {
    const fullMessage: ClusterMessage = {
      id: randomUUID(),
      sender: this.currentNode!.id,
      timestamp: Date.now(),
      ...message,
    };
    
    // 发送给所有在线节点（除了自己）
    for (const node of this.nodes.values()) {
      if (node.id !== this.currentNode!.id && node.status === 'online') {
        await this.sendToNode(node.id, fullMessage);
      }
    }
    
    console.log(`📢 广播消息到集群:`, message.type);
  }
  
  private handleIncomingMessage(message: ClusterMessage, sender: ClusterNode): void {
    console.log(`📩 收到来自 ${sender.name} 的消息:`, message.type);
    
    // 处理消息
    switch (message.type) {
      case 'node.join':
        this.handleNodeJoin(message.payload as ClusterNode);
        break;
      case 'node.leave':
        this.handleNodeLeave(message.payload as { nodeId: string });
        break;
      case 'heartbeat':
        this.handleHeartbeat(message.payload as { nodeId: string });
        break;
      case 'leader.election':
        this.handleLeaderElection(message);
        break;
      case 'leader.elected':
        this.handleLeaderElected(message.payload as { leaderId: string });
        break;
      case 'shard.assignment':
        this.handleShardAssignment(message.payload as { shards: number[] });
        break;
    }
    
    this.emit('message', { message, sender });
  }
  
  private handleNodeJoin(nodeInfo: ClusterNode): void {
    // 更新节点信息
    this.nodes.set(nodeInfo.id, {
      ...nodeInfo,
      status: 'online',
      lastHeartbeat: Date.now(),
    });
    
    console.log(`👋 节点 ${nodeInfo.name} 加入集群`);
    this.emit('node.joined', nodeInfo);
  }
  
  private handleNodeLeave(payload: { nodeId: string }): void {
    const node = this.nodes.get(payload.nodeId);
    if (node) {
      node.status = 'offline';
      this.nodes.set(payload.nodeId, node);
      
      console.log(`👋 节点 ${node.name} 离开集群`);
      this.emit('node.left', node);
    }
  }
  
  private handleHeartbeat(payload: { nodeId: string }): void {
    const node = this.nodes.get(payload.nodeId);
    if (node) {
      node.lastHeartbeat = Date.now();
      this.nodes.set(payload.nodeId, node);
    }
  }
  
  private handleLeaderElection(message: ClusterMessage): void {
    if (this.config.leaderElection && this.currentNode) {
      // 比较节点ID，选择最小的ID作为leader
      const candidateId = message.payload.candidateId;
      const currentNodeId = this.currentNode.id;
      
      if (currentNodeId < candidateId) {
        // 当前节点ID更小，参与选举
        this.sendMessage({
          type: 'leader.election',
          receiver: candidateId,
          payload: { candidateId: currentNodeId },
          timestamp: Date.now(),
          ttl: 10000,
        });
      } else if (currentNodeId === candidateId) {
        // 没有更小的ID，当前节点成为leader
        this.electLeader(currentNodeId);
      }
    }
  }
  
  private handleLeaderElected(payload: { leaderId: string }): void {
    const leaderNode = this.nodes.get(payload.leaderId);
    if (leaderNode) {
      this.leaderNode = leaderNode;
      console.log(`👑 节点 ${leaderNode.name} 当选为Leader`);
      this.emit('leader.elected', leaderNode);
    }
  }
  
  private handleShardAssignment(payload: { shards: number[] }): void {
    if (!this.currentNode) return;
    
    this.currentNode.shards = payload.shards;
    
    // 更新分片映射
    for (const shardId of payload.shards) {
      const mapping = this.shardMappings.get(shardId);
      if (mapping) {
        mapping.primaryNode = this.currentNode.id;
        mapping.status = 'active';
        this.shardMappings.set(shardId, mapping);
      } else {
        // 创建新的分片映射
        this.shardMappings.set(shardId, {
          shardId,
          primaryNode: this.currentNode.id,
          replicaNodes: [],
          status: 'active',
        });
      }
    }
    
    console.log(`🔢 节点分配到分片:`, payload.shards);
    this.emit('shards.assigned', payload.shards);
  }
  
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.currentNode) {
        // 发送心跳
        this.broadcastMessage({
          type: 'heartbeat',
          sender: this.currentNode.id,
          receiver: null,
          payload: { nodeId: this.currentNode.id },
          timestamp: Date.now(),
          ttl: this.config.nodeTimeout,
        }).catch(console.error);
        
        // 检查节点超时
        this.checkNodeTimeouts();
      }
    }, this.config.heartbeatInterval);
  }
  
  private startDiscovery(): void {
    if (this.config.discovery === 'static') {
      // 静态配置，不需要发现
      return;
    }
    
    this.discoveryTimer = setInterval(() => {
      // 动态发现节点的逻辑
      // 这里可以根据discovery类型实现不同的发现机制
      console.debug('🔍 正在发现集群节点...');
    }, 10000);
  }
  
  private checkNodeTimeouts(): void {
    const now = Date.now();
    
    for (const node of this.nodes.values()) {
      if (node.id === this.currentNode?.id) continue;
      
      if (now - node.lastHeartbeat > this.config.nodeTimeout) {
        // 节点超时
        node.status = 'offline';
        this.nodes.set(node.id, node);
        
        console.log(`⚠️ 节点 ${node.name} 超时`);
        this.emit('node.timeout', node);
        
        // 如果是leader超时，触发选举
        if (node.id === this.leaderNode?.id) {
          this.leaderNode = null;
          this.triggerLeaderElection().catch(console.error);
        }
        
        // 如果是分片节点，重新分配分片
        if (this.config.sharding && node.shards.length > 0) {
          this.redistributeShards(node.id).catch(console.error);
        }
      }
    }
  }
  
  private async electLeader(nodeId: string): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (node) {
      this.leaderNode = node;
      
      // 广播leader当选消息
      await this.broadcastMessage({
        type: 'leader.elected',
        sender: nodeId,
        receiver: null,
        payload: { leaderId: nodeId },
        timestamp: Date.now(),
        ttl: 30000,
      });
      
      console.log(`👑 节点 ${node.name} 当选为Leader`);
      this.emit('leader.elected', node);
    }
  }
  
  private async triggerLeaderElection(): Promise<void> {
    if (!this.config.leaderElection) return;
    
    const onlineNodes = Array.from(this.nodes.values()).filter(
      node => node.status === 'online'
    );
    
    if (onlineNodes.length === 0) return;
    
    // 选择最小的节点ID作为初始候选人
    const candidateId = onlineNodes
      .map(node => node.id)
      .sort()[0];
    
    // 开始选举
    await this.broadcastMessage({
      type: 'leader.election',
      sender: candidateId,
      receiver: null,
      payload: { candidateId },
      timestamp: Date.now(),
      ttl: 10000,
    });
  }
  
  private async assignShards(newNodeId: string): Promise<void> {
    if (!this.config.sharding) return;
    
    const onlineNodes = Array.from(this.nodes.values()).filter(
      node => node.status === 'online' && node.shards.length > 0
    );
    
    if (onlineNodes.length === 0) {
      // 第一个节点，分配全部分片
      const shards = Array.from(
        { length: this.config.totalShards },
        (_, i) => i
      );
      
      await this.sendMessage({
        type: 'shard.assignment',
        receiver: newNodeId,
        payload: { shards },
        timestamp: Date.now(),
        ttl: 30000,
      });
      
      return;
    }
    
    // 从现有节点中分一些分片给新节点
    const shardsToMove: number[] = [];
    const targetShardsPerNode = Math.ceil(
      this.config.totalShards / (onlineNodes.length + 1)
    );
    
    for (const node of onlineNodes) {
      if (node.shards.length > targetShardsPerNode) {
        const excessShards = node.shards.length - targetShardsPerNode;
        const shards = node.shards.slice(0, excessShards);
        
        shardsToMove.push(...shards);
        node.shards = node.shards.slice(excessShards);
        
        if (shardsToMove.length >= targetShardsPerNode) {
          break;
        }
      }
    }
    
    if (shardsToMove.length > 0) {
      await this.sendMessage({
        type: 'shard.assignment',
        receiver: newNodeId,
        payload: { shards: shardsToMove },
        timestamp: Date.now(),
        ttl: 30000,
      });
    }
  }
  
  private async redistributeShards(nodeId: string): Promise<void> {
    if (!this.config.sharding) return;
    
    const offlineNode = this.nodes.get(nodeId);
    if (!offlineNode) return;
    
    const lostShards = offlineNode.shards;
    if (lostShards.length === 0) return;
    
    // 找到健康的在线节点
    const onlineNodes = Array.from(this.nodes.values()).filter(
      node => node.id !== nodeId && node.status === 'online'
    );
    
    if (onlineNodes.length === 0) return;
    
    // 将分片分配给其他节点
    let shardIndex = 0;
    for (const shardId of lostShards) {
      const targetNode = onlineNodes[shardIndex % onlineNodes.length];
      
      // 更新分片映射
      const mapping = this.shardMappings.get(shardId);
      if (mapping) {
        mapping.primaryNode = targetNode.id;
        mapping.status = 'active';
        this.shardMappings.set(shardId, mapping);
        
        // 更新目标节点的分片列表
        targetNode.shards.push(shardId);
        this.nodes.set(targetNode.id, targetNode);
        
        // 发送分片分配通知
        await this.sendMessage({
          type: 'shard.assignment',
          receiver: targetNode.id,
          payload: { shards: [shardId] },
          timestamp: Date.now(),
          ttl: 30000,
        });
      }
      
      shardIndex++;
    }
    
    console.log(`🔀 已将节点 ${offlineNode.name} 的分片重新分配`);
  }
}