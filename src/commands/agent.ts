import os from "os";

import chalk from "chalk";
import inquirer from "inquirer";

import { ExecuteCommand } from "../functions";
import { FunctionManager } from "../functions/manager";
import { createLLMProvider } from "../llm";
import { TokenUsage } from "../llm/interface";
import { logger } from "../logger";
import { Thread } from "../repositories";
import { SQLiteThreadRepository } from "../repositories";
import { LLM } from "../services/llm";
import {
  CumulativeCostTracker,
  displayCostInfo,
} from "../services/pricing";
import { getShowCostInfo } from "../utils/context-vars";
const costTracker = new CumulativeCostTracker();

function getSystemInfoFromOS(): string {
  const osType = os.type();
  const osRelease = os.release();
  const osPlatform = os.platform();
  const osArch = os.arch();
  const totalMemory = Math.round(os.totalmem() / (1024 * 1024 * 1024));
  const freeMemory = Math.round(os.freemem() / (1024 * 1024 * 1024));
  const cpuInfo = os.cpus()[0]?.model || "Unknown CPU";
  const cpuCores = os.cpus().length;
  const uptime = Math.round(os.uptime() / 3600);
  const hostname = os.hostname();
  const username = os.userInfo().username;
  const homedir = os.homedir();
  const shell = os.userInfo().shell || "Unknown shell";

  return `
OS: ${osType} ${osRelease} (${osPlatform} ${osArch})
Hostname: ${hostname}
Username: ${username}
Home directory: ${homedir}
Shell: ${shell}
CPU: ${cpuInfo} (${cpuCores} cores)
Memory: ${freeMemory}GB free of ${totalMemory}GB total
Uptime: ${uptime} hours
`;
}

const AGENT_SYSTEM_PROMPT_TEMPLATE = `You are a helpful terminal AI assistant. Help the user accomplish their tasks by executing terminal commands.

SYSTEM INFORMATION:
{{systemInfo}}

CAPABILITIES:
- Execute terminal commands to help users complete their tasks
- Provide information about files, directories, and system status
- Handle errors gracefully and suggest solutions
- Explain commands and their options when needed

GUIDELINES:
- Be concise, precise, and helpful in your responses
- For complex operations, explain what you're doing before executing commands
- Prioritize safe operations; warn about potentially dangerous commands
- If a command execution fails, troubleshoot the issue and suggest alternatives
- When appropriate, suggest better ways to accomplish the user's goal
- Make sure multiline commands are handled correctly and do not use backticks

When the user asks a question or needs assistance, figure out the best way to help them, including using commands when necessary.`;

const EXIT_COMMANDS = ["exit", "quit", "q"];
const HELP_COMMAND = "help";
const PROMPT_SYMBOL = chalk.green(">> ");
const EMPTY_INPUT_MESSAGE = chalk.yellow(
  "Please enter a command or question. Type \\help for available commands.",
);
const EXIT_MESSAGE = chalk.blue("Exiting agent mode");
const HELP_MESSAGE = chalk.cyan(`
Available commands:
  exit, quit, q - Exit agent mode
  help - Show this help message
`);

/**
 * Process user input and check for special commands
 * @returns true if the loop should continue, false if it should exit
 */
async function processUserInput(): Promise<{
  shouldContinue: boolean;
  input: string;
}> {
  const response = await inquirer.prompt([
    {
      type: "input",
      name: "userInput",
      message: PROMPT_SYMBOL,
      default: "",
    },
  ]);

  const trimmedInput = response.userInput.trim();

  if (EXIT_COMMANDS.includes(trimmedInput)) {
    logger.info(EXIT_MESSAGE);
    return { shouldContinue: false, input: trimmedInput };
  }

  if (trimmedInput === HELP_COMMAND) {
    logger.info(HELP_MESSAGE);
    return processUserInput();
  }

  if (!trimmedInput) {
    logger.info(EMPTY_INPUT_MESSAGE);
    return processUserInput();
  }

  return { shouldContinue: true, input: trimmedInput };
}

export interface AgentModeOptions {
  input: string;
  context?: string;
  threadId?: string;
}

export async function runAgentMode({
  input,
  context,
  threadId,
}: AgentModeOptions): Promise<void> {
  try {
    const functionManager = new FunctionManager();
    functionManager.registerFunction(
      ExecuteCommand.executeCommandFunction,
      ExecuteCommand.executeCommandHandler,
    );

    // Get system information using the OS module
    const systemInfo = getSystemInfoFromOS();

    // Create the system prompt with system information
    const AGENT_SYSTEM_PROMPT = AGENT_SYSTEM_PROMPT_TEMPLATE.replace(
      "{{systemInfo}}",
      systemInfo,
    );

    const llmProvider = createLLMProvider();
    const llm = new LLM({
      llmProvider,
      systemPrompt: AGENT_SYSTEM_PROMPT,
      functionManager,
    });

    // Initialize the session manager
    const threadRepository = new SQLiteThreadRepository();

    // Initialize or load thread
    let thread: Thread;
    if (threadId) {
      const existingThread = await threadRepository.getThread(threadId);
      if (!existingThread) {
        logger.info(
          `Thread with ID ${threadId} not found. Creating a new thread.`,
        );
        thread = await threadRepository.createThread();
      } else {
        thread = existingThread;
        logger.info(
          chalk.blue(
            `Loaded thread: ${chalk.bold(thread.name)} (${thread.id})`,
          ),
        );
      }
    } else {
      thread = await threadRepository.createThread();
      logger.info(
        chalk.blue(
          `Created new thread: ${chalk.bold(thread.name)} (${thread.id})`,
        ),
      );
    }

    let conversationHistory = thread.messages;
    let userInput = input;

    if (context && context.trim()) {
      userInput = `${userInput}\n\nAdditional context from piped input:\n${context}`;
      logger.info("Including piped content as additional context");
    }

    // Add the initial user message if starting a new conversation
    if (conversationHistory.length === 0) {
      if (!userInput.trim()) {
        // Welcome message for new threads
        logger.info(chalk.cyan.bold("\n=== Terminal AI Assistant ==="));
        logger.info(
          chalk.cyan(
            "Type your questions or commands. Type \\help for available commands.\n",
          ),
        );

        // If no input is provided and this is a new thread, prompt for input
        const { shouldContinue, input: firstInput } = await processUserInput();
        if (!shouldContinue) {
          return;
        }
        userInput = firstInput;
      }

      conversationHistory.push({
        role: "user",
        content: userInput,
      });
    } else if (userInput.trim()) {
      // If continuing a conversation and input is provided, add it
      conversationHistory.push({
        role: "user",
        content: userInput,
      });
    }

    // Update the thread with the messages
    if (conversationHistory.length > thread.messages.length) {
      await threadRepository.updateThread(thread.id, conversationHistory);
    }

    const totalUsage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      model: llmProvider.getModel(),
    };

    while (true) {
      if (conversationHistory.length > 0) {
        const lastMessage = conversationHistory[conversationHistory.length - 1];
        if (lastMessage.role === "user") {
          logger.info(
            chalk.bold.cyan("\nYou: ") +
            chalk.white(lastMessage.content) +
            "\n",
          );
        }
      }

      const { history, usage } = await llm.generateStreamingCompletion({
        input: userInput,
        onToken: (token: string) => {
          process.stdout.write(chalk.white(token));
          return;
        },
        conversationHistory,
      });

      // Add a newline after streaming is complete
      logger.info("\n");

      conversationHistory = history;

      // Update the thread with new messages
      await threadRepository.updateThread(thread.id, conversationHistory);

      // If this is a new thread with the default name and we now have both user input and AI response,
      // generate a better name based on the conversation content
      if (
        thread.name.startsWith("Thread-") &&
        conversationHistory.length >= 2
      ) {
        const userMessage =
          conversationHistory.find((msg) => msg.role === "user")?.content || "";
        const aiResponse =
          conversationHistory.find((msg) => msg.role === "assistant")
            ?.content || "";

        // Create a name by combining user input and AI response
        const combinedContent = `${userMessage} ${aiResponse}`;
        // Trim to max 120 chars and add ellipsis if truncated
        const truncatedName =
          combinedContent.length > 120
            ? `${combinedContent.substring(0, 120).trim()}...`
            : combinedContent;

        // Update the thread name
        await threadRepository.renameThread(thread.id, truncatedName);
      }

      totalUsage.inputTokens += usage.inputTokens;
      totalUsage.outputTokens += usage.outputTokens;

      // Get next user input if the last message was from the assistant
      if (
        conversationHistory[conversationHistory.length - 1].role === "assistant"
      ) {
        logger.info(chalk.dim("─".repeat(process.stdout.columns || 80)));

        const { shouldContinue, input } = await processUserInput();
        if (!shouldContinue) {
          break;
        }
        if (getShowCostInfo()) {
          displayCostInfo(totalUsage);
        }
        userInput = input;
      }
    }

    // Show a nice exit message with cost info
    logger.info(chalk.dim("─".repeat(process.stdout.columns || 80)));
    logger.info(chalk.blue.bold("Session ended."));
    costTracker.displayTotalCost();
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.info(chalk.red(`\n❌ Error: ${error.message}`));
      logger.error(`Error in agent mode: ${error.message}`);
    } else {
      logger.info(chalk.red(`\n❌ Error: ${String(error)}`));
      logger.error(`Error in agent mode: ${String(error)}`);
    }
  }
}
