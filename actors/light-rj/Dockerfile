FROM apify/actor-node-playwright-chrome:20

# Copy package files
COPY package*.json ./

# Install all dependencies (including devDependencies like tsx required to run the worker)
RUN npm ci --include=dev \
    && echo "Installed NPM packages:" \
    && npm list || true

# Copy source code
COPY . ./

# Run the target start script
CMD npm start
