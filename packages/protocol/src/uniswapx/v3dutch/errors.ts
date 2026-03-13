export class DeadlineReachedError extends Error {
  constructor() {
    super('DeadlineReached');
  }
}

export class InvalidCosignerInputError extends Error {
  constructor() {
    super('InvalidCosignerInput');
  }
}

export class InvalidCosignerOutputError extends Error {
  constructor() {
    super('InvalidCosignerOutput');
  }
}

export class InvalidCosignatureError extends Error {
  constructor() {
    super('InvalidCosignature');
  }
}

export class NoExclusiveOverrideError extends Error {
  constructor() {
    super('NoExclusiveOverride');
  }
}

export class InvalidDecayCurveError extends Error {
  constructor() {
    super('InvalidDecayCurve');
  }
}

export class ArithmeticOverflowError extends Error {
  constructor() {
    super('ArithmeticOverflow');
  }
}
