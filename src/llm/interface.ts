export type MessageRole =
  | "system"
  | "user"
  | "assistant"
  | "function"
  | "function_call";

export type FunctionCallResponse = {
  name: string;
  result: string;
  error?: string;
  callId: string;
};

export type Message<T extends MessageRole> = T extends "function"
  ? {
      role: T;
      content: FunctionCallResponse[];
    }
  : T extends "function_call"
    ? {
        role: T;
        content: FunctionCallResult[];
      }
    : {
        role: T;
        content: string;
      };

export type FunctionParameter = {
  type: string;
  description?: string;
  enum?: string[];
  items?: {
    type: string;
  };
};

export type FunctionDefinition = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, FunctionParameter>;
    required?: string[];
  };
};

export type FunctionCallResult = {
  name: string;
  arguments: Record<string, any>;
  callId: string;
};

export type FunctionHandler = (args: Record<string, any>) => Promise<string>;

export type CompletionOptions = {
  functions?: FunctionDefinition[];
  function_call?: "auto" | "none" | { name: string };
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  model: string;
};

export type CompletionResult = {
  content: string;
  functionCalls?: FunctionCallResult[];
  usage?: TokenUsage;
};

export type LLMProvider = {
  generateStreamingCompletion(
    messages: Message<MessageRole>[],
    onToken: (token: string) => void,
    options?: CompletionOptions,
  ): Promise<CompletionResult>;

  getModel(): string;
};

export type LLMProviderConfig = {
  apiKey?: string;
  model?: string;
  apiEndpoint?: string;
  [key: string]: any;
};
