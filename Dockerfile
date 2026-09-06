FROM node:26-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@10.33.0
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
VOLUME ["/data"]
ENTRYPOINT ["node", "dist/bin.js"]
CMD ["run"]
