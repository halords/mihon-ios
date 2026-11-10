FROM mcr.microsoft.com/playwright:v1.65.0-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY browser-server ./browser-server
COPY src/sources/backupSources.ts src/sources/mangahubAccess.ts ./src/sources/
RUN mkdir /app/.browser-state && chown -R pwuser:pwuser /app/.browser-state
USER pwuser
ENV BROWSER_HOST=0.0.0.0 BROWSER_PORT=4190
EXPOSE 4190
CMD ["node", "browser-server/index.mjs"]
