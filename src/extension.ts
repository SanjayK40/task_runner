import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import axios from 'axios';
let prompt="I am trying to build OpenCV. Please provide only the correct command/commands for the error. Do not include any extra text like 'bash' or any explanations.";
let tf_prompt="I am trying to build TensorFlow. Please provide only the correct command/commands for the error. Do not include any extra text like 'bash' or any explanations.";
let ff_prompt="I am trying to build ffmpeg. Please provide only the correct command/commands for the error. Do not include any extra text like 'bash' or any explanations.";
async function callGPT(output: string, command: string, toggle: boolean): Promise<string[]> {
    const apiKey = "gpt-key";

    try {
        let response;
        if (toggle) {
            response = await axios.post(
                'https://api.openai.com/v1/chat/completions',
                {
                    model: 'gpt-4', // Or use 'gpt-4' if preferred
                    messages: [
                        { role: 'system', content: 'You are a helpful assistant.also the cmake command is correct' },
                        { role: 'user', content: `Analyze the following command output and determine if there is an error, if the command does not give the desired output such that it interferes with the process of the workflow it is considered an error. Return only 'error' or 'no error'.\n\n${output}\nThis is the command:${command}\n if a folder already exists it is not an error` },
                    ],
                    max_tokens: 10, // Limit the response length to just 'error' or 'no error'
                    temperature: 0.3,
                },
                {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                }
            );
            const gptOutput = response.data.choices[0].message.content.trim().toLowerCase();
            if (gptOutput === 'error' || gptOutput === 'no error') {
                return [gptOutput];
            } else {
                return ['no error']; // Default if the response is unexpected
            }
        } else {
            response = await axios.post(
                'https://api.openai.com/v1/chat/completions',
                {
                    model: 'gpt-3.5-turbo', // Or use 'gpt-4' if preferred
                    messages: [
                        { role: 'system', content: 'You are a helpful assistant. Please provide only the correct code for the error without any additional explanations or text. also the cmake command is correct' },
                        { role: 'user', content: `${ff_prompt}\n\n${output}\nThe original command was: ${command}.` }
                    ],
                    max_tokens: 1000, // Limit the response length to just the necessary command
                    temperature: 0.3,
                },
                {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                }
            );
            const gptOutput = response.data.choices[0].message.content.trim();
            
            // Clean up the response to remove unnecessary text like 'bash' or any other non-command content
            const cleanedOutput = gptOutput.replace(/```bash|```/g, '').trim(); // Remove code block markers like 'bash'
            
            // Return the commands split by line if needed
            const gptCommands = cleanedOutput.split('\n');
            return gptCommands;
        }

    } catch (error) {
        console.error('Error with GPT API request:', error);
        return ['api error']; // If an error occurs with the GPT API request
    }
}

// Function to prompt the user for confirmation
async function promptUserForConfirmation(): Promise<boolean> {
    const response = await vscode.window.showQuickPick(['Yes', 'No'], {
        placeHolder: 'Do you want to continue?'
    });
    return response === 'Yes';
}

async function promptUserToQuitDuringExecution(): Promise<boolean> {
    const response = await vscode.window.showQuickPick(['Yes', 'No'], {
        placeHolder: 'Do you want to quit the execution?'
    });
    return response === 'Yes';
}

async function parallel(arr: string[], fn: (command: string) => Promise<{ output: string, error: boolean }>, threads: number = 1): Promise<any[]> {
    const result = [];
    while (arr.length) {
        const res = await Promise.all(arr.splice(0, threads).map(x => fn(x)));
        result.push(res);
    }
    return result.flat();
}



export function activate(context: vscode.ExtensionContext) {
    console.log('Code Fetcher Extension is now active!');

    // Create a new OutputChannel to capture and log output
    const outputChannel = vscode.window.createOutputChannel('Code Fetcher Output');

    let disposable = vscode.commands.registerCommand('snj-code-fetcher.runCommand', async () => {
        // Prompt the user for the file path (or you can hardcode it)
        const fileUri = await vscode.window.showInputBox({
            placeHolder: 'Enter the full file path to your command list (e.g., /path/to/commands.txt)'
        });

        if (fileUri) {
            // Read the file content
            fs.readFile(fileUri, 'utf8', async (err, data) => {
                if (err) {
                    vscode.window.showErrorMessage(`Error reading the file: ${err.message}`);
                    return;
                }

                // Split the content of the file by new lines to get individual commands
                const commands = data.split('\n').map(command => command.trim()).filter(command => command.length > 0);

                // Create an output file to save the results
                const outputFilePath = path.join(path.dirname(fileUri), 'command_outputs.txt');
                fs.writeFileSync(outputFilePath, ''); // Clear the file if it exists

                // Function to execute a command and capture its output
                let currentDir = '/'; // Start with the root directory or an appropriate default.

                async function executeCommand(command: string): Promise<{ output: string, error: boolean }> {
                    return new Promise((resolve) => {
                        // Handle "cd" commands
                        if (command.startsWith('cd ')) {
                            const targetDir = command.substring(3).trim();
                            const resolvedPath = path.resolve(currentDir, targetDir);
                
                            if (fs.existsSync(resolvedPath)) {
                                currentDir = resolvedPath; // Update the current directory
                                resolve({ output: `Changed directory to ${resolvedPath}`, error: false });
                            } else {
                                resolve({ output: `Directory not found: ${resolvedPath}`, error: true });
                            }
                            return;
                        }
                
                        // For other commands, execute them in the current directory
                        const child = spawn(command, { shell: true, cwd: currentDir });
                
                        let output = '';
                        let errorOutput = '';
                        let passwordPromise: Promise<void> | null = null;



                        child.stdout.on('data', (data) => {
                            const message = data.toString();
                            output += message;
                            console.log(message); 
                            outputChannel.appendLine(message); // This should append output to the output channel
                            outputChannel.show(true);
                        });
                        const maxErrorLines = 5;  // Maximum number of error lines to display
                        
                        child.stderr.on('data', (data) => {
                            const message = data.toString();
                            console.error(message);  // Log to console for debugging
                            
                            errorOutput += message;
                            
                            // Split the error output into lines and trim it to the last 'maxErrorLines' lines
                            const errorLines = errorOutput.split('\n');
                            if (errorLines.length > maxErrorLines) {
                                errorOutput = errorLines.slice(-maxErrorLines).join('\n');
                            }
                            
                            // Append the error output to the output channel
                            outputChannel.appendLine(errorOutput);
                            output=errorOutput;
                            // Handle password prompts
                            if (message.toLowerCase().includes('password')) {
                                if (!passwordPromise) {
                                    passwordPromise = (async () => {
                                        const password = await vscode.window.showInputBox({
                                            prompt: 'Enter your sudo password:',
                                            password: true,
                                            ignoreFocusOut: true,
                                        });
                
                                        if (password) {
                                            child.stdin.write(`${password}\n`);
                                        } else {
                                            outputChannel.appendLine('Password input canceled. Terminating command.');
                                            outputChannel.show(true);
                                            child.kill(); // Terminate the process
                                            resolve({ output: 'Password input canceled. Command aborted.', error: true });
                                        }
                                    })();
                                }
                            }
                        });
                
                        // Handle command completion
                        child.on('close', async (code) => {
                            if (passwordPromise) {
                                await passwordPromise; // Ensure password handling completes before resolving
                            }
                
                            // Use GPT to analyze the output
                            const gptResponse = await callGPT(output,command, true);
                
                            if (gptResponse[0] === 'error') {
                                outputChannel.appendLine('GPT detected an error. Preparing to execute correction logic...');
                                outputChannel.show(true);
                                resolve({ output, error: true });
                            } else if (gptResponse[0] === 'no error') {
                                outputChannel.appendLine('GPT did not detect any errors.');
                                outputChannel.show(true);
                                resolve({ output, error: false });
                            } else {
                                outputChannel.appendLine('GPT API error.');
                                outputChannel.show(true);
                                resolve({ output, error: true });
                            }
                        });
                    });
                }
                // let commandStack: string[] = []; 
                async function stack_calls(commands:string[]):Promise<void>{

                while (commands.length > 0) {
                    const command = commands.shift();  // Pop the next command from the stack
                    if (!command) {continue;};  // Skip if the command is undefined
            
                    outputChannel.appendLine(`Executing command: ${command}`); 
                    outputChannel.show(true);
                    fs.appendFileSync(outputFilePath, `Command: ${command}\n`);
                    const userConfirmed = await promptUserForConfirmation();
                    if (!userConfirmed) {
                        outputChannel.appendLine('User chose to stop. Aborting further execution.');
                        return;  // Exit the loop if the user chooses not to continue
                    }
                    const { output, error } = await executeCommand(command);
                    fs.appendFileSync(outputFilePath, `Output:\n${output}\n`);
            
                    if (error) {
                        outputChannel.appendLine(`GPT detected an error. Preparing to execute correction logic...: ${command}`);
                        fs.appendFileSync(outputFilePath, `GPT detected an error. Preparing to execute correction logic...\n`);
                        
                        const gptCommands = await callGPT(output, command, false);
                        fs.appendFileSync(outputFilePath, `Correct commands:\n${gptCommands}\n`);
                        outputChannel.appendLine(`GPT Commands: ${gptCommands}`);
                        // Push the new corrected commands onto the stack
                        commands.unshift(...gptCommands);
                        // fs.appendFileSync(outputFilePath, `\n\ncommands after pushing: \n${commands}\n\n`);
                        // outputChannel.appendLine(`GPT Commands: ${gptCommands}`);
                    } else {
                        outputChannel.appendLine('GPT did not detect an error. Continuing execution...');
                        fs.appendFileSync(outputFilePath, `GPT did not detect an error. Continuing execution...\n`);
                        fs.appendFileSync(outputFilePath, '----------------------------------------\n');
                        
                        // Wait for user confirmation before continuing to the next command

                    }
            
                }
            }
                            await stack_calls(commands);
                            // Notify the user that the output has been saved
                            vscode.window.showInformationMessage(`Command outputs saved to ${outputFilePath}`);
                            outputChannel.show();
                        });
                    }
                });

                context.subscriptions.push(disposable);
            }

export function deactivate() {}

