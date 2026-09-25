FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY ./ ./
ARG NEXT_PUBLIC_KF_API=http://localhost:8000
ENV NEXT_PUBLIC_KF_API=$NEXT_PUBLIC_KF_API
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/package-lock.json ./package-lock.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/next.config.mjs ./next.config.mjs
USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
