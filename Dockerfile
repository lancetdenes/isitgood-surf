# Node.js + Python for GRIB processing
FROM node:20-slim

# Install Python, curl, and GRIB dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    curl bash \
    libeccodes-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python dependencies
COPY data/scripts/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /app/.venv && \
    /app/.venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt

# Node dependencies
COPY package.json /app/
RUN npm install --production

# App files
COPY server.js /app/
COPY public/ /app/public/

# Scripts go to /app/scripts (NOT /app/data — that's the volume mount)
COPY data/scripts/ /app/scripts/
RUN chmod +x /app/scripts/*.sh

# Startup script: copies scripts into volume if missing, then starts server
RUN cat <<'ENTRY' > /app/entrypoint.sh
#!/bin/bash
set -e
# Always sync latest scripts into the volume (overwrite old versions)
mkdir -p /app/data/scripts
cp /app/scripts/* /app/data/scripts/ 2>/dev/null || true
chmod +x /app/data/scripts/*.sh 2>/dev/null || true
exec node server.js
ENTRY
RUN chmod +x /app/entrypoint.sh

ENV PORT=3000
ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 3000

CMD ["/app/entrypoint.sh"]
