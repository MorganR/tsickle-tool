const DEFAULT_GREETING = "Hello";

/** Greets people with a static greeting. */
export class Greeter {
  /**
   * Construsts a greeter with the given greeting.
   * @param greeting Should just be the prefix before the name, with no trailing space, eg. "Hello".
   */
  constructor(private readonly greeting: string) {}

  greet(name: string): string {
    return this.greeting + " " + name + "!";
  }
}

const DEFAULT_GREETER = new Greeter(DEFAULT_GREETING);

/** Returns a default greeter. */
export function defaultGreeter(): Greeter {
  return DEFAULT_GREETER;
}
