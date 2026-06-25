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

# Start processes concurrently using start.js
CMD ["node", "start.js"]
