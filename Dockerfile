# Nexus Browser Worker — Playwright + Chromium on Node 20.
# Uses the official Playwright image so Chromium and its system
# dependencies are already installed (no `playwright install` step).
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Run as the image's non-root user; /app must belong to it.
RUN chown -R pwuser:pwuser /app
USER pwuser

CMD ["node", "server.js"]
