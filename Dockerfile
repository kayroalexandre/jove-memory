FROM node:22-alpine

# No model weights, no ML runtime. This image is a Node process and nothing else.
# The absence of onnxruntime and @huggingface/transformers is deliberate (ADR-009).

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src/ ./src/
COPY scripts/ ./scripts/

# Run unprivileged
RUN addgroup -S jove && adduser -S jove -G jove && chown -R jove:jove /app
USER jove

ENV NODE_ENV=production
EXPOSE 8888

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8888/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/api/server.mjs"]
