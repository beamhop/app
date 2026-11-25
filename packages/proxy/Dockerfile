# Beamhop proxy (Node). Build from this directory:
#   docker build -t beamhop-proxy .
#   docker run --rm -p 8787:8787 -e BH_PROXY_TOKENS=change-me beamhop-proxy
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json build.mjs ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN node build.mjs

FROM node:22-alpine
ENV NODE_ENV=production BH_PROXY_HOST=0.0.0.0 BH_PROXY_PORT=8787
COPY --from=build /src/dist/beamhop-proxy.mjs /app/beamhop-proxy.mjs
USER node
EXPOSE 8787
CMD ["node", "/app/beamhop-proxy.mjs"]
