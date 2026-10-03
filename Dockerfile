# For Cloud Run: gcloud run deploy intake-desk --source . --set-env-vars ...
FROM node:22-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "npx next start -p ${PORT}"]
