import { z } from "zod";

export type InputType =
    | z.ZodString
    | z.ZodNumber
    | z.ZodBoolean
    | z.ZodEnum<any>
    | z.ZodOptional<any>
    | z.ZodDefault<any>;

export type InputDefinition<T extends InputType = InputType> = {
    name: string;
    description: string;
    schema: T;
    argument?: boolean;
    default?: z.infer<T>;
    choices?: readonly z.infer<T>[];
};

export type CommandInputs = readonly InputDefinition[];

export type TypedInputs<T extends CommandInputs> = {
    [K in T[number]["name"]]: z.infer<Extract<T[number], { name: K }>["schema"]>;
};

export type TypedCommand<T extends CommandInputs = any, R = void> = {
    readonly name: string;
    readonly description: string;
    readonly category: "common" | "review" | "cicd";
    readonly aliases: string[];
    readonly inputs: CommandInputs;
    /**
     * Print this command's help instead of running it when it is invoked with no inputs at all.
     * For a command whose flags select between modes rather than modify one default action
     * (see OnboardCommand), a bare invocation has nothing to do, and the options are the answer.
     */
    readonly helpWhenNoInputs?: boolean;
    execute: (inputs: TypedInputs<T>) => Promise<R>;
};

export const TOP_LEVEL_CATEGORIES: Array<TypedCommand["category"]> = ["common", "review"];
