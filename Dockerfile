FROM ghcr.io/puppeteer/puppeteer:24.1.0

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true\
    PUPPETEER_EXCUTABLE-PATH=/usr/bin/google-chrome-stable

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci
COPY . .
CMD ["node", "index.js"] 