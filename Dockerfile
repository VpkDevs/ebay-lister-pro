# Use official Node.js 20 LTS slim image
FROM node:20-slim

# Create and define the application directory
WORKDIR /usr/src/app

# Copy package files
COPY package.json ./

# Copy all source files
COPY . .

# Expose the web server port
EXPOSE 45900

# Set environment defaults
ENV PORT=45900
ENV NODE_ENV=production

# [HARDENING] Persist app state (billing records + listing history) on a
# volume: all mutable state lives under LISTER_STATE_DIR (data/ + scratch/).
# Mount a volume at /data or the first container recreate wipes every
# customer's paid status and listings.
ENV LISTER_STATE_DIR=/data
VOLUME ["/data"]

# Start processes concurrently using start.js
CMD ["node", "start.js"]
