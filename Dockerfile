FROM docker.io/cloudflare/sandbox:0.12.7

RUN wget --no-check-certificate -qO- https://github.com/coder/code-server/releases/download/v4.131.0/code-server-4.131.0-linux-amd64.tar.gz | tar -xz -C /usr/local --strip-components=1

EXPOSE 8080
