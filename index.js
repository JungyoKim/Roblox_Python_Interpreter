const socketio = require('socket.io');
const http = require('http');
const puppeteer = require('puppeteer');
const dot = require('dotenv').config();

class ExecutionQueue {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        this.currentTask = null;
        this.onStateChange = null; // 상태 변경 콜백
    }

    setStateChangeCallback(callback) {
        this.onStateChange = callback;
    }

    notifyStateChange() {
        if (this.onStateChange) {
            this.onStateChange({
                waiting: this.queue.length,
                isProcessing: this.isProcessing
            });
        }
    }

    addToQueue(task) {
        const promise = new Promise((resolve, reject) => {
            this.queue.push({
                task,
                resolve,
                reject,
                canceled: false
            });
        });
        
        this.notifyStateChange(); // 큐에 추가될 때 상태 변경 알림
        this.processQueue();
        
        return promise;
    }

    async processQueue() {
        if (this.isProcessing || this.queue.length === 0) return;
        
        this.isProcessing = true;
        this.notifyStateChange(); // 처리 시작할 때 상태 변경 알림
        
        this.currentTask = this.queue.shift();
        
        try {
            if (!this.currentTask.canceled) {
                await this.currentTask.task();
                this.currentTask.resolve();
            }
        } catch (error) {
            if (!this.currentTask.canceled) {
                this.currentTask.reject(error);
            }
        } finally {
            this.currentTask = null;
            this.isProcessing = false;
            this.notifyStateChange(); // 처리 완료될 때 상태 변경 알림
            this.processQueue();
        }
    }

    cancelCurrentTask() {
        if (this.currentTask) {
            this.currentTask.canceled = true;
            this.notifyStateChange(); // 태스크 취소될 때 상태 변경 알림
        }
    }

    getQueueStatus() {
        return {
            waiting: this.queue.length,
            isProcessing: this.isProcessing
        };
    }
}

const server = http.createServer();

const io = socketio(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        allowedHeaders: ["content-type"],  // 허용할 헤더 명시적 지정
        credentials: true
    },
    handlePreflightRequest: (req, res) => {
        res.writeHead(200, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST",
            "Access-Control-Allow-Headers": "content-type",
            "Access-Control-Allow-Credentials": "true"
        });
        res.end();
    }
});

const executionQueue = new ExecutionQueue();
let browser;

executionQueue.setStateChangeCallback((queueStatus) => {
    const status = {
        connectedClients: io.engine.clientsCount,
        queueStatus
    };
    io.emit('server_status', status);
});

(async () => {
    browser = await puppeteer.launch({ 
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
})();

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);
    let currentPage = null;
    let outputInterval = null;
    let completionInterval = null;

    const cleanup = async () => {
        if (outputInterval) {
            clearInterval(outputInterval);
            outputInterval = null;
        }
        if (completionInterval) {
            clearInterval(completionInterval);
            completionInterval = null;
        }
        if (currentPage) {
            try {
                await currentPage.close();
            } catch (error) {
                console.error('Page close error:', error);
            }
            currentPage = null;
        }
    };

    socket.on('execute_python', async (pythonCode) => {
        console.log(pythonCode)
        try {
            await executionQueue.addToQueue(async () => {
                try {
                    await cleanup(); // 이전 실행 정리
                    let isExecutionComplete = false;
                    
                    currentPage = await browser.newPage();
                    
                    // Handle Python input() prompts
                    currentPage.on('dialog', async dialog => {
                        try {
                            console.log('Input requested:', dialog.message());
                            socket.emit('input_required', dialog.message());
                            
                            const response = await new Promise((resolve, reject) => {
                                const timeout = setTimeout(() => {
                                    reject(new Error('Input timeout'));
                                }, 30000);
    
                                socket.once('input_response', data => {
                                    clearTimeout(timeout);
                                    resolve(data);
                                });
    
                                socket.once('disconnect', () => {
                                    clearTimeout(timeout);
                                    reject(new Error('Client disconnected'));
                                });
                            });
                            
                            if (dialog) {
                                await dialog.accept(response);
                            }
                        } catch (error) {
                            console.error('Dialog error:', error);
                            if (dialog) await dialog.dismiss().catch(console.error);
                            throw error;
                        }
                    });
    
                    let previousContent = '';
                    
                    const checkOutput = async () => {
                        try {
                            if (!currentPage || isExecutionComplete) return;
    
                            const content = await currentPage.evaluate(() => {
                                const output = document.querySelector("textarea#output");
                                return output ? output.value : '';
                            });
    
                            if (content !== previousContent) {
                                const newContent = content.slice(previousContent.length);
                                const lines = newContent.split('\n').filter(line => line.trim());
                                
                                for (const line of lines) {
                                    console.log(line);
                                    socket.emit('output', line);
                                    
                                    if (line.includes('<completed')) {
                                        isExecutionComplete = true;
                                    }
                                }
                                
                                previousContent = content;
                            }
    
                        } catch (error) {
                            if (!error.message.includes('detached')) {
                                console.error('Output check error:', error);
                            }
                        }
                    };
    
                    await currentPage.goto('https://ishaanbhimwal.github.io/online-python-compiler/');
                    
                    await currentPage.evaluate((value) => {
                        const editor = ace.edit("editor");
                        editor.setValue(value);
                    }, pythonCode.data);
    
                    const runButtonSelector = 'a[onclick="main()"]';
                    await currentPage.click(runButtonSelector);
    
                    outputInterval = setInterval(checkOutput, 100);
    
                    // 실행 완료 대기
                    await new Promise((resolve) => {
                        const maxExecutionTime = 30000; // 30초 제한
                        const startTime = Date.now();
                        
                        completionInterval = setInterval(() => {
                            // 최대 실행 시간 체크
                            if (Date.now() - startTime > maxExecutionTime) {
                                isExecutionComplete = true;
                                resolve();
                                return;
                            }
                            
                            // 완료 메시지 체크
                            if (isExecutionComplete) {
                                resolve();
                            }
                        }, 100);
                    });
    
                    socket.emit('execution_complete');
                    console.log("complete");
                    
                } finally {
                    await cleanup();
                }
            });
        } catch (error) {
            console.error('Execution error:', error);
            if (socket.connected) {
                socket.emit('execution_error', error.message);
            }
            await cleanup();
        }
    });

    socket.emit('server_status', {
        connectedClients: io.engine.clientsCount,
        queueStatus: executionQueue.getQueueStatus()
    });

    socket.on('disconnect', async () => {
        console.log('Client disconnected:', socket.id);
        await cleanup();
        executionQueue.cancelCurrentTask();
        
        // 연결이 끊긴 후 남은 클라이언트들에게 상태 전송
        io.emit('server_status', {
            connectedClients: io.engine.clientsCount - 1, // 현재 클라이언트가 아직 카운트에 포함되어 있으므로 1 감소
            queueStatus: executionQueue.getQueueStatus()
        });
    });
});

const PORT = 2000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
});

// 정상적인 서버 종료 처리
process.on('SIGINT', async () => {
    if (browser) {
        await browser.close();
    }
    process.exit(0);
});

// 예기치 않은 에러 처리
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // 서버를 종료하지 않고 계속 실행
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // 서버를 종료하지 않고 계속 실행
});