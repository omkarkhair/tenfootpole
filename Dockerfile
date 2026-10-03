# ---- builder: fetch OSV malicious-package advisories (MAL-*) only ----------
# The full npm DB is ~200 MB zipped; the malicious subset is a small fraction.
FROM docker.io/cloudflare/sandbox:0.13.0-next.738.2 AS osv
RUN apt-get update && apt-get install -y --no-install-recommends zip unzip curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ARG OSV_SCANNER_VERSION=v2.6.0
RUN curl -fsSL -o /osv-scanner https://github.com/google/osv-scanner/releases/download/${OSV_SCANNER_VERSION}/osv-scanner_linux_amd64 \
 && chmod +x /osv-scanner
RUN set -e; for eco in npm PyPI; do \
      mkdir -p /db/osv-scalibr/$eco /tmp/$eco; \
      curl -fsSL -o /tmp/$eco.zip https://osv-vulnerabilities.storage.googleapis.com/$eco/all.zip; \
      unzip -q /tmp/$eco.zip 'MAL-*.json' -d /tmp/$eco; \
      (cd /tmp/$eco && zip -q -r /db/osv-scalibr/$eco/all.zip .); \
      echo "$eco: $(ls /tmp/$eco | wc -l) advisories"; \
    done

# ---- final image ------------------------------------------------------------
FROM docker.io/cloudflare/sandbox:0.13.0-next.738.2

RUN wget --no-check-certificate -qO- https://github.com/coder/code-server/releases/download/v4.131.0/code-server-4.131.0-linux-amd64.tar.gz | tar -xz -C /usr/local --strip-components=1

# Pi coding agent (pinned).
RUN npm install -g @earendil-works/pi-coding-agent@1.0.0 && npm cache clean --force

# Scanner: OSV-scanner + offline malicious-package DB.
COPY --from=osv /osv-scanner /usr/local/bin/osv-scanner
COPY --from=osv /db /opt/tfp/osv-db
ENV OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY=/opt/tfp/osv-db

# Auto-exec surface check, banner and Pi config.
COPY image/autoexec.mjs image/banner.sh /opt/tfp/
COPY image/pi/ /root/.pi/agent/
RUN chmod +x /opt/tfp/banner.sh

EXPOSE 8080
