// Congela o objeto e tudo que está dentro dele. Payload e data de evento nunca mudam
// depois de criados: o que foi para a outbox é o que será publicado.
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) {
      deepFreeze(inner);
    }
  }
  return value;
}
