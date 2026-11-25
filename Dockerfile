FROM oven/bun:1.4.5

WORKDIR /app

# Dependências primeiro: esta camada só é refeita quando package.json ou bun.lock mudam.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

USER bun
EXPOSE 3000

# O Bun executa o TypeScript direto, sem etapa de build.
CMD ["bun", "src/main.ts"]
