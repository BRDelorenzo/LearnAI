FROM node:20-alpine

# Evita timezone maluco
ENV TZ=UTC

WORKDIR /app

# Instala ffmpeg runtime (alpine)
RUN apk add --no-cache ffmpeg

# Copia package da raiz e backend
COPY ../package.json /app/package.json
COPY ../nodemon.json /app/nodemon.json
RUN npm ci --omit=dev

COPY . /app/backend
COPY ../public /app/public

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
CMD ["node", "backend/server.js"]
