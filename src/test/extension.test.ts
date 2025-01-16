import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import axios from 'axios';

async function callGPT(output: string, toggle: boolean): Promise<string> {
    const apiKey = "gpt-key";

    try {
        let response;
        if(toggle){            
            response = await axios.post(
                'https://api.openai.com/v1/chat/completions',
                {
                    model: 'gpt-3.5-turbo', // Or use 'gpt-4' if preferred
                    messages: [
                        { role: 'system', content: 'You are a helpful assistant.' },
                        { role: 'user', content: `Analyze the following command output and determine if there is an error, if the command does not give desired output such that it interfers with the process of the workflow it is considered an error. Return only 'error' or 'no error'.\n\n${output}` },
                        { role: 'user', content: `Toggle: ${toggle}` }, // Add the toggle input here
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
                return gptOutput;
            } else {
                return 'no error'; // Default if the response is unexpected
            }
        }
        else{
            response = await axios.post(
                'https://api.openai.com/v1/chat/completions',
                {
                    model: 'gpt-3.5-turbo', // Or use 'gpt-4' if preferred
                    messages: [
                        { role: 'system', content: 'You are a helpful assistant.' },
                        { role: 'user', content: `Analyze the following command output and determine if there is an error, if the command does not give desired output such that it interfers with the process of the workflow it is considered an error. if there is error then return the correct command/commands.\n\n${output}` },
                        { role: 'user', content: `Toggle: ${toggle}` }, // Add the toggle input here
                    ],
                    max_tokens: 1000, // Limit the response length to just 'error' or 'no error'
                    temperature: 0.3,
                },
                {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                }
            );
            const gptOutput = response.data.choices[0].message.content;
            return gptOutput;
        }

    } catch (error) {
        console.error('Error with GPT API request:', error);
        return 'api error'; // If an error occurs with the GPT API request
    }
}

// Function to prompt the user for confirmation
async function promptUserForConfirmation(): Promise<boolean> {
    const response = await vscode.window.showQuickPick(['Yes', 'No'], {
        placeHolder: 'Do you want to continue?'
    });
    return response === 'Yes';
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
                async function executeCommand(command: string): Promise<{ output: string, error: boolean }> {
                    return new Promise((resolve) => {
                        const child = spawn(command, { shell: true });
                    
                        let output = '';
                        let errorOutput = '';
                        let passwordPromise: Promise<void> | null = null; // Explicitly set to null initially
                        let yesNoPromise: Promise<void> | null = null;
                
                        // Capture stdout
                        child.stdout.on('data', (data) => {
                            output += data.toString();
                            outputChannel.appendLine(data.toString()); // Show output immediately in OutputChannel
                        });
                
                        // Capture stderr and handle password prompt
                        child.stderr.on('data', (data) => {
                            const message = data.toString();
                            errorOutput += message;
                            outputChannel.appendLine(message); // Show error output immediately
                
                            // Handle password prompt
                            if (message.includes('password') || message.includes('Password')) {
                                if (!passwordPromise) {
                                    passwordPromise = (async () => {
                                        const password = await vscode.window.showInputBox({
                                            prompt: 'Enter your sudo password:',
                                            password: true,
                                            ignoreFocusOut: true,
                                        });
                
                                        if (password) {
                                            child.stdin.write(`${password}\n`);
                                            const response=await promptUserForConfirmation();
                                            if (response) {
                                                child.stdin.write('y\n');
                                            } else {
                                                child.stdin.write('n\n');
                                                outputChannel.appendLine('User chose not to continue. Command aborted.');
                                                child.kill(); // Terminate the process
                                                resolve({ output: 'User chose not to continue. Command aborted.', error: true });
                                            }
                                        } else {
                                            outputChannel.appendLine('Password input canceled. Terminating command.');
                                            child.kill(); // Terminate the process
                                            resolve({ output: 'Password input was canceled. Command aborted.', error: true });
                                        }
                                    })();
                                }
                            }
            
                        });
                
                        // Handle command completion
                        child.on('close', async (code) => {
                            if (passwordPromise) {
                                await passwordPromise; // Ensure the password and yes/no logic finishes before resolving
                            }
                            const gptResponse=await callGPT(output,true);

                            if (gptResponse === 'error') {
                                outputChannel.appendLine('GPT detected an error. Preparing to execute correction logic...');
                                // Placeholder for error correction logic (e.g., running additional commands)
                                // You can add your logic here to handle the error or fix the issue based on GPT's response
                                resolve({ output, error: false });
                            } else if (gptResponse==='no error') {
                                outputChannel.appendLine('GPT did not detect any errors. Continuing execution...');
                                resolve({ output: errorOutput, error: true });
                            }
                            else{
                            outputChannel.appendLine('gpt api error');
                            resolve({ output: errorOutput, error: true });
                            }
                        });
                    });
                }

                // Execute each command and handle errors
                for (let command of commands) {
                    // Save the command to the output file
                    fs.appendFileSync(outputFilePath, `Command: ${command}\n`);

                    // Execute the command and capture its output
                    const { output, error } = await executeCommand(command);
                    
                    // Save the output to the output file
                    fs.appendFileSync(outputFilePath, `Output:\n${output}\n`);
                    // fs.appendFileSync(outputFilePath, `Error Detected: ${gptResponse.error ? 'Yes' : 'No'}\n`);


                    // Check if an error occurred
                    if (error) {
                        outputChannel.appendLine(`GPT detected an error. Preparing to execute correction logic...: ${command}`);
                        fs.appendFileSync(outputFilePath, `GPT detected an error. Preparing to execute correction logic...\n`);
                        // const sol = await callGPT(output);
                        const gptCommands = await callGPT(output,false);
                        fs.appendFileSync(outputFilePath, `correct commands:\n${gptCommands}\n`);

                    }
                    else if (!error)  {
                            fs.appendFileSync(outputFilePath, `GPT did not detect an error. Continuing execution...\n`);
                            outputChannel.appendLine('GPT did not detect an error. Continuing execution...');
                        }
                    else{
                            fs.appendFileSync(outputFilePath, `error in gpt api\n`);
                            outputChannel.appendLine('error in gpt api');
                        }
                    
                    fs.appendFileSync(outputFilePath, '----------------------------------------\n');
                    // Wait for user confirmation before continuing to the next command
                    const userConfirmed = await promptUserForConfirmation();
                    if (!userConfirmed) {
                        outputChannel.appendLine('User chose to stop. Aborting further execution.');
                        break; // Exit the loop if user chooses not to continue
                    }
                }

                // Notify the user that the output has been saved
                vscode.window.showInformationMessage(`Command outputs saved to ${outputFilePath}`);
                outputChannel.show();
            });
        }
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}

