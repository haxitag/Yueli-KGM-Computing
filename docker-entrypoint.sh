#!/bin/sh
set -e

: "${KGM_MOCK_MODE:=0}"
export KGM_MOCK_MODE

# 等待依赖服务就绪
if [ "$WAIT_FOR_DEPENDENCIES" = "true" ]; then
  echo "Waiting for dependencies to be ready..."
  
  # 等待Redis
  if [ -n "$REDIS_URL" ]; then
    REDIS_HOST=$(echo $REDIS_URL | sed 's/redis:\/\///' | cut -d':' -f1)
    REDIS_PORT=$(echo $REDIS_URL | sed 's/redis:\/\///' | cut -d':' -f2 | cut -d'/' -f1)
    
    echo "Waiting for Redis at $REDIS_HOST:$REDIS_PORT..."
    while ! nc -z $REDIS_HOST $REDIS_PORT; do
      sleep 1
    done
    echo "Redis is ready!"
  fi
  
  # 等待 NATS
  if [ -n "$NATS_URL" ]; then
    NATS_HOST=$(echo $NATS_URL | sed 's/nats:\/\///' | cut -d':' -f1)
    NATS_PORT=$(echo $NATS_URL | sed 's/nats:\/\///' | cut -d':' -f2)
    
    echo "Waiting for NATS at $NATS_HOST:$NATS_PORT..."
    while ! nc -z $NATS_HOST $NATS_PORT; do
      sleep 1
    done
    echo "NATS is ready!"
  fi

  # 等待前站 micro-worker（encoder 轨）
  if [ -n "$KGM_FRONTSTATION_INTENT_URL" ]; then
    FS_HOST=$(echo "$KGM_FRONTSTATION_INTENT_URL" | sed -E 's#https?://([^/:]+).*#\1#')
    FS_PORT=$(echo "$KGM_FRONTSTATION_INTENT_URL" | sed -E 's#https?://[^/:]+(:([0-9]+))?.*#\2#')
    FS_PORT=${FS_PORT:-8091}
    echo "Waiting for frontstation-worker at $FS_HOST:$FS_PORT..."
    while ! nc -z "$FS_HOST" "$FS_PORT"; do
      sleep 1
    done
    echo "frontstation-worker is ready!"
  fi
fi

# 设置集群配置
if [ -n "$CLUSTER_NAME" ]; then
  echo "Configuring cluster: $CLUSTER_NAME"
  export KGM_CLUSTER_NAME=$CLUSTER_NAME
fi

if [ -n "$NODE_NAME" ]; then
  echo "Node name: $NODE_NAME"
  export KGM_NODE_NAME=$NODE_NAME
fi

if [ -n "$NODE_ROLE" ]; then
  echo "Node role: $NODE_ROLE"
  export KGM_NODE_ROLE=$NODE_ROLE
fi

if [ -n "$DISCOVERY" ]; then
  echo "Discovery method: $DISCOVERY"
  export KGM_CLUSTER_DISCOVERY=$DISCOVERY
fi

if [ -n "$CLUSTER_NODES" ]; then
  echo "Cluster nodes: $CLUSTER_NODES"
  export KGM_CLUSTER_NODES=$CLUSTER_NODES
fi

# 设置存储配置
if [ -n "$STORAGE_BACKEND" ]; then
  echo "Storage backend: $STORAGE_BACKEND"
  export KGM_STORAGE_BACKEND=$STORAGE_BACKEND
fi

if [ -n "$REDIS_URL" ]; then
  echo "Redis URL: $REDIS_URL"
  export KGM_REDIS_URL=$REDIS_URL
fi

if [ -n "$REDIS_PASSWORD" ]; then
  export KGM_REDIS_PASSWORD=$REDIS_PASSWORD
fi

# 设置监控配置
if [ -n "$JAEGER_ENDPOINT" ]; then
  echo "Jaeger endpoint: $JAEGER_ENDPOINT"
  export KGM_JAEGER_ENDPOINT=$JAEGER_ENDPOINT
fi

if [ -n "$PROMETHEUS_ENDPOINT" ]; then
  echo "Prometheus endpoint: $PROMETHEUS_ENDPOINT"
  export KGM_PROMETHEUS_ENDPOINT=$PROMETHEUS_ENDPOINT
fi

if [ -n "$METRICS_PORT" ]; then
  echo "Metrics port: $METRICS_PORT"
  export KGM_METRICS_PORT=$METRICS_PORT
fi

# 生成节点ID（如果未设置）
if [ -z "$KGM_NODE_ID" ]; then
  export KGM_NODE_ID=$(cat /proc/sys/kernel/random/uuid)
  echo "Generated node ID: $KGM_NODE_ID"
fi

# 打印环境摘要
echo "=== Environment Summary ==="
echo "Node ID: $KGM_NODE_ID"
echo "Node Name: $KGM_NODE_NAME"
echo "Node Role: $KGM_NODE_ROLE"
echo "Cluster: $KGM_CLUSTER_NAME"
echo "Discovery: $KGM_CLUSTER_DISCOVERY"
echo "Storage: $KGM_STORAGE_BACKEND"
echo "Metrics Port: $KGM_METRICS_PORT"
echo "Frontstation: mode=${KGM_FRONTSTATION_MODE:--} prefer_onnx=${KGM_FRONTSTATION_PREFER_ONNX:--} intent_url=${KGM_FRONTSTATION_INTENT_URL:-}"
echo "==========================="

# 执行主命令
exec "$@"
