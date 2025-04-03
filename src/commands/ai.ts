import inquirer from 'inquirer';
import { execTerminalCommand, isSystemModifyingCommand } from '../utils';
import { createLLMProvider, LLMProviderType } from '../llm';
import { CommandProcessor } from '../services';
import { getSystemInfoFunction, getSystemInfoHandler } from '../functions';
import { CumulativeCostTracker } from '../utils/pricing-calculator';
import { runAgentMode } from './agent';
import { Command } from 'commander';
import { readConfig } from '../utils/config';
import { Message, MessageRole } from '../llm/interface';
import chalk from 'chalk';

// Default system prompt for basic mode
const BASIC_SYSTEM_PROMPT = 
  'You are a helpful terminal assistant. Convert natural language requests into terminal commands. ' +
  'Respond with ONLY the terminal command, nothing else.';

// Create a global cost tracker for the application
export const costTracker = new CumulativeCostTracker();

// Store conversation history for agent mode
let conversationHistory: Message[] = [];

/**
 * Process an AI command in basic mode
 * @param input User input to be processed
 */
export async function processAiCommand(input: string): Promise<void> {
  try {
    console.log(`Processing: "${input}"`);
    
    // Create the LLM provider and command processor
    const llmProvider = createLLMProvider();
    const commandProcessor = new CommandProcessor(llmProvider, BASIC_SYSTEM_PROMPT, true);
    
    // Register available functions (only system info in basic mode)
    commandProcessor.registerFunction(getSystemInfoFunction, getSystemInfoHandler);
    
    // Process the natural language command
    const terminalCommand = await commandProcessor.processCommand(input);
    
    // Execute the command with appropriate handling
    await executeTerminalCommand(terminalCommand);
  } catch (error) {
    console.error('Error:', error);
  }
}

/**
 * Execute a terminal command with appropriate safety checks
 * @param command The command to execute
 */
async function executeTerminalCommand(command: string): Promise<void> {
  if (isSystemModifyingCommand(command)) {
    // Handle commands that modify the system
    console.log(`>>>> \`${command}\` y or n?`);
    
    const { confirm } = await inquirer.prompt([
      {
        type: 'input',
        name: 'confirm',
        message: '',
      }
    ]);
    
    if (confirm.toLowerCase() === 'y') {
      try {
        await execTerminalCommand(command, false);
      } catch (error) {
        // If command fails, try with sudo
        const { sudoConfirm } = await inquirer.prompt([
          {
            type: 'input',
            name: 'sudoConfirm',
            message: 'Command failed. Retry with sudo? (y/n):',
          }
        ]);
        
        if (sudoConfirm.toLowerCase() === 'y') {
          await execTerminalCommand(command, true);
        }
      }
    }
  } else {
    // Handle read-only commands - execute without confirmation
    console.log(`Executing: ${command}`);
    try {
      await execTerminalCommand(command, false);
    } catch (error) {
      console.error('Command execution failed');
    }
  }
}

// Re-export the agent mode function
export { runAgentMode };

/**
 * AI command for processing natural language commands
 */
export function aiCommand(program: Command) {
  program
    .command('ai')
    .description('AI-powered terminal command interpreter')
    .argument('[input...]', 'Natural language command to execute')
    .option('-a, --agent', 'Run in agent mode with continuous conversation')
    .action(async (input: string[], options: { agent?: boolean }) => {
      try {
        // Read configuration
        const config = readConfig();
        
        if (!config) {
          console.error(chalk.red('Configuration not found. Please run "ai init" first.'));
          process.exit(1);
        }
        
        // Create LLM provider
        const llmProvider = createLLMProvider(config.provider, {
          apiKey: config.apiKey,
          model: config.model,
          apiEndpoint: config.apiEndpoint
        });
        
        // Create command processor
        const processor = new CommandProcessor(llmProvider);
        
        // Check if we're in agent mode
        if (options.agent) {
          console.log(chalk.blue('Agent mode activated. Type "exit" or "quit" to end the session.'));
          
          // If input was provided, process it first
          if (input.length > 0) {
            const initialInput = input.join(' ');
            console.log(chalk.green(`\nYou: ${initialInput}`));
            
            // Process with streaming output
            console.log(chalk.yellow('\nAI: '));
            const command = await processor.processCommand(
              initialInput,
              undefined, // Use default stdout writer
              conversationHistory
            );
            
            // Add to conversation history
            conversationHistory.push(
              { role: MessageRole.USER, content: initialInput },
              { role: MessageRole.ASSISTANT, content: command }
            );
            
            console.log(chalk.cyan(`\n\nExecuting: ${command}`));
          }
          
          // Start interactive loop
          const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
          });
          
          const askQuestion = () => {
            readline.question(chalk.green('\nYou: '), async (userInput: string) => {
              if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit') {
                console.log(chalk.blue('Ending agent session.'));
                readline.close();
                return;
              }
              
              // Process with streaming output
              console.log(chalk.yellow('\nAI: '));
              const command = await processor.processCommand(
                userInput,
                undefined, // Use default stdout writer
                conversationHistory
              );
              
              // Add to conversation history
              conversationHistory.push(
                { role: MessageRole.USER, content: userInput },
                { role: MessageRole.ASSISTANT, content: command }
              );
              
              console.log(chalk.cyan(`\n\nExecuting: ${command}`));
              
              // Continue the loop
              askQuestion();
            });
          };
          
          askQuestion();
        } else {
          // Single command mode
          if (input.length === 0) {
            console.error(chalk.red('Please provide a command to execute.'));
            process.exit(1);
          }
          
          const userInput = input.join(' ');
          console.log(chalk.green(`\nYou: ${userInput}`));
          
          // Process with streaming output
          console.log(chalk.yellow('\nAI: '));
          const command = await processor.processCommand(userInput);
          
          console.log(chalk.cyan(`\n\nExecuting: ${command}`));
        }
      } catch (error: any) {
        console.error(chalk.red(`Error: ${error.message}`));
        process.exit(1);
      }
    });
} 