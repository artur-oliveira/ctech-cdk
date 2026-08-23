#!/bin/bash
# Alpine/OpenRC equivalent of assets/ec2/setup-nginx.sh. The nginx.conf body
# is byte-for-byte the same (nginx's config format doesn't change with the
# OS) — only install/enable at the bottom differ.
#
# Usage: setup-nginx.sh <nginx-port> <app-port> <health-path> [rate-per-second] [max-body] [app-port-alt]
set -euo pipefail

NGINX_PORT="${1:?setup-nginx.sh: nginx listen port required}"
APP_PORT="${2:?setup-nginx.sh: app upstream port required}"
HEALTH_PATH="${3:?setup-nginx.sh: health check path required}"
RATE="${4:-100}"
MAX_BODY="${5:-1m}"
APP_PORT_ALT="${6:-}"

mkdir -p /etc/nginx/conf.d

cat > /etc/nginx/nginx.conf << 'NGINX'
user nginx;
pid /run/nginx.pid;
worker_processes auto;
worker_rlimit_nofile 65535;
error_log /var/log/nginx/error.log warn;

events {
    worker_connections 8192;
    use epoll;
    multi_accept on;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    include /etc/nginx/conf.d/realip*.conf;

    log_format json_log escape=json '{"remote_addr":"$remote_addr","status":$status,"request":"$request","body_bytes_sent":$body_bytes_sent,"request_time":$request_time,"upstream_response_time":"$upstream_response_time"}';

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 30;
    keepalive_requests 10000;
    reset_timedout_connection on;
    open_file_cache max=1000 inactive=20s;
    open_file_cache_valid 30s;
    open_file_cache_min_uses 2;
    open_file_cache_errors on;

    types_hash_max_size 2048;
    types_hash_bucket_size 128;

    client_header_timeout 15s;
    client_body_timeout 30s;
    send_timeout 30s;

    client_max_body_size __MAX_BODY__;
    client_body_buffer_size 128k;
    client_header_buffer_size 1k;
    large_client_header_buffers 4 8k;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_types application/json application/problem+json application/javascript text/plain text/css;

    server_tokens off;
    proxy_hide_header X-Powered-By;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    limit_req_zone $binary_remote_addr zone=req_by_ip:10m rate=__RATE__r/s;
    limit_conn_zone $binary_remote_addr zone=conn_by_ip:10m;
    limit_req_status  429;
    limit_conn_status 429;

    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      "";
    }

    include /etc/nginx/conf.d/http-*.conf;

    upstream app {
        server 127.0.0.1:__APP_PORT__;
__APP_PORT_ALT_LINE__
        keepalive 256;
        keepalive_requests 10000;
        keepalive_timeout 60s;
    }

    server {
        listen __NGINX_PORT__ default_server reuseport;
        server_name _;
        access_log /var/log/nginx/access.log json_log;
        error_log /var/log/nginx/error.log;

        include /etc/nginx/conf.d/location-*.conf;

        location = __HEALTH_PATH__ {
            proxy_pass http://app;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;
            proxy_connect_timeout 5s;
            proxy_read_timeout 5s;
            access_log off;
        }

        location / {
            limit_req  zone=req_by_ip burst=200 nodelay;
            limit_conn conn_by_ip 100;
            include /etc/nginx/conf.d/proxy-*.conf;

            proxy_pass http://app;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $remote_addr;
            proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
            proxy_connect_timeout 10s;
            proxy_send_timeout 60s;
            proxy_read_timeout 60s;
            proxy_buffering on;
            proxy_buffer_size 8k;
            proxy_buffers 16 16k;
            proxy_busy_buffers_size 32k;
        }
    }
}
NGINX

sed -i \
  -e "s|__NGINX_PORT__|${NGINX_PORT}|g" \
  -e "s|__APP_PORT__|${APP_PORT}|g" \
  -e "s|__HEALTH_PATH__|${HEALTH_PATH}|g" \
  -e "s|__RATE__|${RATE}|g" \
  -e "s|__MAX_BODY__|${MAX_BODY}|g" \
  /etc/nginx/nginx.conf

if [ -n "$APP_PORT_ALT" ]; then
  sed -i "s|__APP_PORT_ALT_LINE__|        server 127.0.0.1:${APP_PORT_ALT};|" /etc/nginx/nginx.conf
  mkdir -p /opt/app
  echo "$APP_PORT" > /opt/app/app-port
else
  sed -i "/__APP_PORT_ALT_LINE__/d" /etc/nginx/nginx.conf
fi

nginx -t

rc-update add nginx default
rc-service nginx start
