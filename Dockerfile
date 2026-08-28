FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    openjdk-17-jre-headless \
    pdftk-java \
    fonts-liberation \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund --unsafe-perm

COPY . .

ENV NODE_ENV=production
ENV PORT=7860

EXPOSE 7860

CMD ["npm", "run", "start"]
