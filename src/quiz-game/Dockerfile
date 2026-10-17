FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
