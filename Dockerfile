FROM node:22-slim

WORKDIR /app

# Download Obsidian renderer files during build (cached as a layer)
COPY scripts/ scripts/
RUN node scripts/update-obsidian.js --no-cache

# Install server dependencies
COPY server/package*.json server/
RUN cd server && npm ci --omit=dev

# Copy source
COPY server/ server/
COPY client/ client/
COPY test-vault/ test-vault/

COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r//' /entrypoint.sh && chmod +x /entrypoint.sh

ENV HOST=0.0.0.0
ENV PORT=3500

EXPOSE 3500

WORKDIR /app/server
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "index.js"]
