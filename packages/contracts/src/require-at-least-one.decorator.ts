import { type ValidationArguments, registerDecorator } from 'class-validator';

export function RequireAtLeastOne(fields: readonly string[]): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      constraints: [fields],
      name: 'requireAtLeastOne',
      propertyName: String(propertyKey),
      target: target.constructor,
      validator: {
        defaultMessage(arguments_: ValidationArguments): string {
          const requiredFields = arguments_.constraints[0] as readonly string[];
          return `At least one of ${requiredFields.join(', ')} must contain a value`;
        },
        validate(_value: unknown, arguments_: ValidationArguments): boolean {
          const requiredFields = arguments_.constraints[0] as readonly string[];
          const object = arguments_.object as Record<string, unknown>;
          return requiredFields.some((field) => {
            const value = object[field];
            return typeof value === 'string' && value.trim().length > 0;
          });
        },
      },
    });
  };
}
