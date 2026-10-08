# Orbit Relay 部署（阿里云 ECS）

手机走公网连电脑，不依赖局域网。整条链路：

```text
手机 ──wss──► Caddy(TLS) ──► orbit-relay(Bun, 127.0.0.1:8787) ──► 电脑上的 Orbit Host
                                   ▲ 只转发，不解密应用帧（E2EE）
```

## 前置

- 一台 ECS（Debian/Ubuntu），安全组放行 **80 / 443**。
- 一个域名，A 记录解析到这台 ECS 的公网 IP（wss 的 Let's Encrypt 证书需要域名）。

## 一键部署

把本目录传到服务器（或用 scp），然后：

```sh
# 在服务器上
sudo ./deploy.sh relay.你的域名.com '<HOST_KEY>'
```

`<HOST_KEY>` 用 32–256 位 URL 安全字符串，例如本地生成：

```sh
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

脚本会：装 bun + caddy → 拷贝 server.mjs / systemd → 写 Caddyfile 和
`/etc/orbit-relay.env` → 启动两个服务 → 跑一次 `https://域名/health` 自检。

成功后验证：

```sh
curl https://relay.你的域名.com/health
# {"service":"orbit-relay","hosts":0,"uptime":...}
```

## 手工部署（不用脚本时）

```sh
# 1. 装 bun + caddy（见 deploy.sh 里同款命令）

# 2. 放文件
sudo mkdir -p /opt/orbit-relay
sudo cp server.mjs /opt/orbit-relay/
sudo cp orbit-relay.service /etc/systemd/system/

# 3. 写 Caddyfile（/etc/caddy/Caddyfile）
#    relay.你的域名.com { encode zstd gzip; header_up X-Real-IP {remote_host}; reverse_proxy 127.0.0.1:8787 }

# 4. 写 /etc/orbit-relay.env（600 权限）
#    ORBIT_RELAY_HOST_KEY=<HOST_KEY>

# 5. 启动
sudo systemctl daemon-reload
sudo systemctl enable --now orbit-relay
sudo systemctl enable --now caddy
```

## 电脑端 + 手机端

1. Orbit → 设置 → General → 移动访问 → 连接方式选「公网中转 · 阿里云」。
2. 公网中转配置里：Relay 地址 = `wss://relay.你的域名.com`，Host Key = 上面那个。
3. 保存 → 开启移动访问 → 手机扫码。
