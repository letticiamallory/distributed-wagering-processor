// Uma dependência que o serviço precisa para trabalhar (o banco, a fila) e que o /health/ready
// testa DE VERDADE: uma operação real contra ela, com prazo, nunca "a configuração existe".
export abstract class ReadinessProbe {
  abstract readonly name: string;
  // true: respondeu dentro do prazo. false: caiu, recusou ou demorou demais. Nunca lança.
  abstract isUp(): Promise<boolean>;
}
