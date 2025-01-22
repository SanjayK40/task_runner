import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import axios from 'axios';
let lib:string="openCV";
let prompt = `I am trying to build ${lib}. Please provide only the correct commands for the error. Do not include any extra text like 'bash' or 'sh' or any explanations. If the git clone command has already been executed and the directory exists, treat this as successful and not an error. If libraries are missing, only include the commands to install those specific libraries, and make sure to install the necessary ones to complete the build.`;

// let tf_prompt="I am trying to build TensorFlow. Please focus , Do not include any extra text like 'bash' or any explanations, just the command.";
// let ff_prompt="I am trying to build ffmpeg. Please provide only the correct command/commands for the error. Do not include any extra text like 'bash' or any explanations.";




async function callGPT(output: string,command_hist:string[], commands: string[], toggle: boolean): Promise<string[]> {
    const apiKey = "gpt-key";

    try {
        let response;
        if (toggle) {
            response = await axios.post(
                'https://api.openai.com/v1/chat/completions',
                {
                    model: 'gpt-4o', // Or use 'gpt-4' if preferred
                    messages: [
                        { role: 'system', content: 'You are a helpful assistant. If a directory already exists due to a successful git clone or prior operation, it is not considered an error. Only flag an error if a library is missing or cannot be found, or if there is a failure related to the build process. Do not flag successful cloning or existing directories as errors. Focus on identifying missing dependencies or other critical issues in the build.' },
                        { role: 'user', content: `Analyze the following command output and determine if there is an error. Only return 'error' if a library is missing or if there's a critical issue preventing the build. If the git clone command was successful and the folder already exists, it is not an error. \n\n${output}\nThese are the commands: ${commands}\nPreviously executed commands: ${command_hist}` },
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
                    model: 'gpt-4o', // Or use 'gpt-4' if preferred
                    messages: [
                        { role: 'system', content: 'You are a helpful assistant. The cmake command is correct. Treat any existing directory from git clone as a success and not an error.Please make sure to give all the commands from the point of erroneous command to complete the build.' },
                        { role: 'user', content: `${prompt}\n\n${output}\nThese are the commands:${commands}\n these are the previously executed commands:${command_hist}\n.Please add -S when you generate sudo commands.` }
                    ],
                    max_tokens: 15000,
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
    let command_hist:string[]=[];
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

                async function executeCommand(commands: string[], command_hist: string[], command: string): Promise<{ output: string, error: boolean }> {
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
                            console.log('stdout:', message); // Debug log
                            outputChannel.appendLine(message);
                            outputChannel.show(true);
                        });
                        const maxTokens = 15000;

                        // Function to clip output to the last maxTokens tokens
                        function clipOutput(output:string) {
                            const tokens = output.split(/\s+/);  // Split by whitespace to count tokens
                            if (tokens.length > maxTokens) {
                                output = tokens.slice(-maxTokens).join(' ');  // Keep only the last maxTokens tokens
                            }
                            return output;
                            }
                        child.stderr.on('data', (data) => {
                            const message = data.toString();
                            console.error('stderr:', message); // Debug log
                        
                            // Capture stderr for git clone as part of normal output
                            if (command.startsWith('git clone')) {
                                output += message;  // Treat stderr as part of normal output
                                outputChannel.appendLine(message);
                                outputChannel.show(true);
                            } else {
                                    // Treat stderr separately for non-git commands
                                    errorOutput += message;

                                    // Clip error output to last maxTokens tokens
                                    errorOutput = clipOutput(errorOutput);

                                    outputChannel.appendLine(errorOutput);
                                    output = errorOutput;
                            }
                        
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
                                            const answer = await vscode.window.showQuickPick(["Y", "n"], {
                                                placeHolder: "Do you want to continue?",
                                                ignoreFocusOut: true,
                                            });
                        
                                            if (answer === "Y") {
                                                child.stdin.write('Y\n');
                                            } else {
                                                outputChannel.appendLine('User declined to continue. Terminating command.');
                                                outputChannel.show(true);
                                                child.kill();
                                            }
                                        } else {
                                            outputChannel.appendLine('Password input canceled. Terminating command.');
                                            outputChannel.show(true);
                                            child.kill();
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
                
                            // Debug log to verify output
                            console.log('Command output:', output);
                            console.log('Command error output:', errorOutput);
                
                            // Use GPT to analyze the output
                            const gptResponse = await callGPT(output, command_hist, commands, true);
                
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
                async function combined(commands: string[]): Promise<void> {
                    while (commands.length > 0) {
                        const command = commands.shift();  // Take the first command from the list
                        if (!command) {continue;};
                
                        outputChannel.appendLine(`Executing command: ${command}`);
                        outputChannel.show(true);
                        fs.appendFileSync(outputFilePath, `Command: ${command}\n`);
                
                        const userConfirmed = await promptUserForConfirmation();
                        if (!userConfirmed) {
                            outputChannel.appendLine('User chose to stop. Aborting further execution.');
                            return;
                        }
                
                        // Execute the command
                        const { output, error } = await executeCommand(commands,command_hist,command);
                        fs.appendFileSync(outputFilePath, `Output:\n${output}\n`);

                        if (error) {
                            outputChannel.appendLine(`GPT detected an error. Preparing to execute correction logic...: ${command}`);
                            fs.appendFileSync(outputFilePath, `GPT detected an error. Preparing to execute correction logic...\n`);
                
                            // Call GPT with both command history and current command list
                            commands.unshift(command);
                            const gptResponse = await callGPT(output, command_hist, commands,false);
                
                            // GPT response is expected to be commands separated by new lines
                            const newCommands = gptResponse;
                
                            // Overwrite the commands list with new commands from GPT
                            commands.length = 0;
                            commands.push(...newCommands);
                
                            fs.appendFileSync(outputFilePath, `New command list:\n${newCommands.join("\n")}\n`);
                            fs.appendFileSync(outputFilePath, `old command list:\n${command_hist}`);
                            outputChannel.appendLine(`Old command list: ${command_hist}\n`);
                            outputChannel.appendLine(`GPT generated new command list: ${newCommands}`);
                        } else {
                            command_hist.push(command);
                            outputChannel.appendLine('Command executed successfully. Proceeding to next command...');
                            fs.appendFileSync(outputFilePath, 'Command executed successfully. Proceeding to next command...\n');
                            fs.appendFileSync(outputFilePath, '----------------------------------------\n\n');
                        }
                    }
                
                    outputChannel.appendLine('All commands executed successfully.');
                }
                // let commandStack: string[] = []; 
            //     async function stack_calls(commands:string[]):Promise<void>{
            //     let commandCountMap: Map<string, number> = new Map();
            //     while (commands.length > 0) {
            //         const command = commands.shift();  // Pop the next command from the stack
            //         if (!command) {continue;};  // Skip if the command is undefined
            //         if (commandCountMap.has(command)) {
            //             commandCountMap.set(command, commandCountMap.get(command)! + 1);
            //         } else {
            //             commandCountMap.set(command, 1);
            //         }
            //         if (commandCountMap.get(command)! > 2) {
            //             const loop = await vscode.window.showQuickPick(["Yes", "No"], {
            //                 placeHolder: `Command "${command}" executed ${commandCountMap.get(command)} times. Terminate execution?`,
            //                 ignoreFocusOut: true,
            //             });
            
            //             if (loop === "Yes") {
            //                 outputChannel.appendLine(`Execution terminated due to potential infinite loop with command: ${command}`);
            //                 return;
            //             }
            //         }
            //         outputChannel.appendLine(`Executing command: ${command}`); 
            //         outputChannel.show(true);
            //         fs.appendFileSync(outputFilePath, `Command: ${command}\n`);
            //         const userConfirmed = await promptUserForConfirmation();
            //         if (!userConfirmed) {
            //             outputChannel.appendLine('User chose to stop. Aborting further execution.');
            //             return;  // Exit the loop if the user chooses not to continue
            //         }
            //         const { output, error } = await executeCommand(command);
            //         fs.appendFileSync(outputFilePath, `Output:\n${output}\n`);
            
            //         if (error) {
            //             outputChannel.appendLine(`GPT detected an error. Preparing to execute correction logic...: ${command}`);
            //             fs.appendFileSync(outputFilePath, `GPT detected an error. Preparing to execute correction logic...\n`);
            //             if (output.includes("already exists and is not an empty directory.")) {
            //                 outputChannel.appendLine(`Skipping further "git clone" commands as the directory already exists.`);
            //                 continue;  // Skip processing further clone attempts
            //             }
            //             const gptCommands = await callGPT(output, command, false);
            //             fs.appendFileSync(outputFilePath, `Correct commands:\n${gptCommands}\n`);
            //             outputChannel.appendLine(`GPT Commands: ${gptCommands}`);
            //             // Push the new corrected commands onto the stack
            //             commands.unshift(...gptCommands);
            //             // fs.appendFileSync(outputFilePath, `\n\ncommands after pushing: \n${commands}\n\n`);
            //             // outputChannel.appendLine(`GPT Commands: ${gptCommands}`);
            //         } else {
            //             outputChannel.appendLine('GPT did not detect an error. Continuing execution...');
            //             fs.appendFileSync(outputFilePath, `GPT did not detect an error. Continuing execution...\n`);
            //             fs.appendFileSync(outputFilePath, '----------------------------------------\n');
                        
            //             // Wait for user confirmation before continuing to the next command

            //         }
            
            //     }
            // }
                            // await stack_calls(commands);
                            await combined(commands);
                            // Notify the user that the output has been saved
                            vscode.window.showInformationMessage(`Command outputs saved to ${outputFilePath}`);
                            outputChannel.show();
                        });
                    }
                });

                context.subscriptions.push(disposable);
            }

export function deactivate() {}

