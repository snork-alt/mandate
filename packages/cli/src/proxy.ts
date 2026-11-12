/**
 * Reverse-proxy snippets for server mode. MCP and live updates use SSE (long-lived streamed responses): buffering
 * must be off and read timeouts long, or agents see stalled tool calls and the UI stops updating.
 */

export interface ProxyInput {
  publicUrl: string;
  /** Where Mandate listens, as seen from the proxy (default 127.0.0.1:<port>). */
  upstream: string;
}

export function caddySnippet({ publicUrl, upstream }: ProxyInput): string {
  const host = new URL(publicUrl).host;
  return `# /etc/caddy/Caddyfile — Caddy gets and renews the HTTPS certificate automatically.
${host} {
\treverse_proxy ${upstream} {
\t\t# Stream SSE (MCP + live updates) immediately; never buffer.
\t\tflush_interval -1
\t\ttransport http {
\t\t\tread_timeout 24h
\t\t\twrite_timeout 24h
\t\t}
\t}
}
`;
}

export function nginxSnippet({ publicUrl, upstream }: ProxyInput): string {
  const host = new URL(publicUrl).hostname;
  return `# /etc/nginx/sites-available/mandate — get a certificate with: sudo certbot --nginx -d ${host}
server {
    listen 443 ssl;
    http2 on;
    server_name ${host};
    # ssl_certificate / ssl_certificate_key: added by certbot

    client_max_body_size 20m;

    location / {
        proxy_pass http://${upstream};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header Connection "";

        # SSE (MCP streams + live updates): no buffering, long timeouts.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 24h;
        proxy_send_timeout 24h;
        chunked_transfer_encoding on;
    }
}

server {
    listen 80;
    server_name ${host};
    return 301 https://$host$request_uri;
}
`;
}

/** SSH tunnel to reach a server-mode install safely before HTTPS is set up. */
export const sshTunnel = (port: number, target = 'user@your-server') => `ssh -N -L ${port}:localhost:${port} ${target}`;
