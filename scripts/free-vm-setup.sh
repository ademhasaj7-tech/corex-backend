#!/usr/bin/env bash
set -euo pipefail

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Copied .env.example to .env. Edit it before starting the app."
fi

sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

cat <<'EOF' | sudo tee /etc/apt/sources.list.d/docker.list
# Added by corex deploy script
deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable
EOF

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"

mkdir -p /opt/corex/data /opt/corex/bots /opt/corex/tmp

# Re-run this command in a fresh shell if group change doesn't apply immediately.
docker compose up -d --build

echo "Deployment started. Check logs with: docker compose logs -f"
