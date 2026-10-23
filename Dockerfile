FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY desktop/package.json desktop/package.json
COPY desktop-next/package.json desktop-next/package.json
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src src
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY desktop/package.json desktop/package.json
COPY desktop-next/package.json desktop-next/package.json
RUN npm ci --omit=dev --ignore-scripts && mkdir /data && chown node:node /data
COPY --from=build /app/dist dist
USER node
EXPOSE 8787
STOPSIGNAL SIGTERM
CMD ["node", "dist/server/main.js"]
