export class AgentTimeoutError extends Error {
  constructor(seconds: number) {
    super(`Agent task timed out after ${seconds} seconds`);
    this.name = "AgentTimeoutError";
  }
}

export class AgentStoppedError extends Error {
  constructor() {
    super("Agent task was stopped");
    this.name = "AgentStoppedError";
  }
}
