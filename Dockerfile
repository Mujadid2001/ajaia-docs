FROM node:22-slim
WORKDIR /app
COPY package*.json ./
# --ignore-scripts: better-sqlite3 ships prebuilt .node binaries in prebuilds/
# and loads them directly. Without this flag npm auto-generates a
# `node-gyp rebuild` install script (it does this whenever a package ships a
# binding.gyp), which needs python3 + a C++ toolchain that node:22-slim lacks —
# so the image fails to build. That gyp run is only a stamp-only stub anyway.
# If you ever add a dependency that really needs an install script, drop this
# flag and add `apt-get install -y python3 make g++` to the image instead.
RUN npm ci --omit=dev --ignore-scripts
COPY . .
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/app.db
EXPOSE 3000
CMD ["node", "src/server.js"]
