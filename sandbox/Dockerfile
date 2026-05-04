# LocalClaw Secure Sandbox Image
FROM node:20-slim

# Install basic engineering tools
RUN apt-get update && apt-get install -y \
    git \
    curl \
    python3 \
    make \
    g++ \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user for execution
RUN useradd -m -s /bin/bash operator
USER operator
WORKDIR /workspace

# Default command
CMD ["/bin/bash"]
