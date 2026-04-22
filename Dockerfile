FROM node:22-alpine

WORKDIR /app

# Dependencias (capa cacheable). Solo producción.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

# Código. Logs, .env, node_modules del host, etc. quedan fuera por .dockerignore.
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

USER node
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "scripts/04-webhook-stripe.js"]
