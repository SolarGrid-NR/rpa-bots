FROM node:20-alpine

WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies like tsx)
# Using npm install instead of npm ci because there is no package-lock.json
RUN npm install --include=dev \
    && echo "Installed NPM packages:" \
    && npm list || true

# Copy source code
COPY . ./

# Run the target start script
CMD npm start
