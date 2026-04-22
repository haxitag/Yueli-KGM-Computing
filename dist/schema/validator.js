export function validateAgainstSchema(schema, value) {
    const errors = [];
    const schemaType = schema.type;
    if (schemaType === "object") {
        if (!isObject(value)) {
            errors.push("value is not an object");
        }
        else {
            const required = schema.required ?? [];
            for (const key of required) {
                if (!(key in value)) {
                    errors.push(`missing required field: ${key}`);
                }
            }
            const properties = schema.properties ?? {};
            for (const key of required) {
                const propSchema = properties[key];
                const propValue = value[key];
                if (propSchema?.type && !matchesType(propSchema.type, propValue)) {
                    errors.push(`invalid type for ${key}: expected ${propSchema.type}`);
                }
                if (propSchema?.enum && !propSchema.enum.includes(propValue)) {
                    errors.push(`invalid enum for ${key}`);
                }
            }
        }
    }
    return { ok: errors.length === 0, errors };
}
function matchesType(schemaType, value) {
    switch (schemaType) {
        case "string":
            return typeof value === "string";
        case "number":
            return typeof value === "number" && !Number.isNaN(value);
        case "object":
            return isObject(value);
        case "array":
            return Array.isArray(value);
        case "boolean":
            return typeof value === "boolean";
        default:
            return true;
    }
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
