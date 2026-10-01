FROM node:22-alpine

# This image is a Node process and nothing else.
#
# No model weights, no ONNX runtime, no local transformer library. The whole
# project treats local model inference as forbidden (ADR-009): embedding,
# inference and decisions all go to cloud providers. Keeping the runtime out
# means ~1.2 GB less disk and a materially smaller dependency attack surface.

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
