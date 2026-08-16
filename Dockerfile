FROM node:26-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    fontconfig \
    fonts-inter \
    fonts-dejavu-core \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm prune --omit=dev
EXPOSE 3000
CMD ["node", "server.js"]