/* @flow
 */

// We didn't find any Stream library that would be flow-typed and that we liked.
// So we made our own library for emitters and streams, that was supposed to be simple...
//
// ... well it got big over time. So here it is.
//
// We are probably reinventing the wheel here. But it is OUR wheel.
//
// TODO: get rid of `stream.dispose()` entirely. It is never really
// clear what it actually does... for example, if you have
// stream.map(()=>{...}), .dispose() also disposes the original
// but stream.fromEmitter(..), .dispose does not destroy emitter
// etc..... but we rely on it in mytrezor :( can't remove now
//
// Emitter -> something that emits things
// Stream -> emits things and also emits (void) finish
// StreamWithEnding -> emits things and also emits finish with different type

import { deferred } from './deferred';

// making sure that Error from a promise is an Error object
function formatError(error: mixed): Error {
    if (typeof error === 'object' && error != null && error instanceof Error) {
        return error;
    } else {
        return new Error(JSON.stringify(error));
    }
}

// having detach function in the handler is actually very useful
// because we don't have to name the function when attaching emitter
type Handler<T> = (value: T, detach: () => void) => void;

// const MAX_LISTENERS = 50;
export class Emitter<T> {
    listeners: Array<Handler<T>> = [];
    destroyed: boolean = false;

    destroy() {
        this.listeners.forEach(handler => this.detach(handler));
        this.listeners = [];
        this.destroyed = true;
    }

    // `attach` doesn't affect currently running `emit`, so listeners are not
    // modified in place.
    attach(handler: Handler<T>) {
        if (this.destroyed) {
            throw new Error('Attaching on a destroyed emitter');
        }
        // this is to prevent possible unintended effects
        // (not necessary, remove if you REALLY need to do this)
        this.listeners.forEach(oldHandler => {
            if (oldHandler === handler) {
                throw new Error('Cannot attach the same listener twice');
            }
        });
        this.listeners.push(handler);
    }

    detach(handler: Handler<T>) {
        // if destroyed => let it be, let it be
        this.listeners = this.listeners.filter((listener) => {
            if (listener === handler) {
                return false;
            } else {
                return true;
            }
        });
    }

    emit(value: T) {
        if (this.destroyed) {
            // if destroyed -> not really throwing error (nothing bad happens), just warn
            console.warn(new Error('Emitting on a destroyed emitter'));
        }
        this.listeners.forEach((listener) => {
            listener(value, () => {
                this.detach(listener);
            });
        });
    }
}

export type Disposer = () => void;
type Finisher = () => void;
type Updater<T> = (value: T) => void;
type Controller<T> = (update: Updater<T>, finish: Finisher) => Disposer;

export class Stream<T> {
    values: Emitter<T>;
    finish: Emitter<void>;
    dispose: Disposer;

    // note that this never "finishes"
    // note that dispose does NOT destroy the emitter
    static fromEmitter<T>(
        emitter: Emitter<T>,
        dispose: () => void
    ): Stream<T> {
        return new Stream((update, finish) => {
            let disposed = false;
            const handler = (t) => {
                // check for disposed not needed, handler is removed
                update(t);
            };
            emitter.attach(handler);
            return () => {
                if (!disposed) {
                    disposed = true;
                    emitter.detach(handler);
                    dispose();
                }
            };
        });
    }

    static fromEmitterFinish<T>(
        emitter: Emitter<T>,
        finisher: Emitter<void>,
        dispose: () => void
    ): Stream<T> {
        return new Stream((update, finish) => {
            let disposed = false;
            const handler = (t) => {
                update(t);
            };
            emitter.attach(handler);
            const finishHandler = (nothing, detach) => {
                finish();
                detach();
                emitter.detach(handler);
            };
            finisher.attach(finishHandler);
            return () => {
                // TODO - this is why dispose does not make much sense
                // should dispose() be called when finish() has been called? or no?
                // I want to get rid of dispose eventually
                if (!disposed) {
                    disposed = true;
                    emitter.detach(handler);
                    finisher.detach(finishHandler);
                    dispose();
                }
            };
        });
    }

    static empty(
    ): Stream<T> {
        return new Stream((update, finish) => {
            let disposed = false;
            setTimeout(() => {
                if (!disposed) {
                    finish();
                }
            }, 0);
            return () => {
                disposed = true;
            };
        });
    }

    static fromPromise<T>(
        promise: Promise<Stream<T>>
    ): Stream<Error | T> {
        const nstream = new Stream((update, finish) => {
            let stream_;
            let disposed = false;
            promise.then(stream => {
                if (!disposed) {
                    if (!stream.disposed) {
                        stream.values.attach(v => update(v));
                        stream.finish.attach(() => finish());
                        stream_ = stream;
                    } else {
                        // uhhh I donno
                        nstream.dispose();
                    }
                }
            }, (error) => {
                if (!disposed) {
                    update(formatError(error));
                    setTimeout(
                      () => {
                          if (!disposed) {
                              finish();
                          }
                      }, 10
                    );
                }
            });
            return () => {
                disposed = true;
                if (stream_ != null) {
                    stream_.dispose();
                }
            };
        });
        return nstream;
    }

    static setLater<T>(): {
        stream: Stream<T>,
        setter: (s: Stream<T>) => void,
    } {
        const df = deferred();
        let set = false;
        const setter = (s: Stream<T>) => {
            if (set) {
                throw new Error('Setting stream twice.');
            }
            set = true;
            df.resolve(s);
        };
        // $FlowIssue the promise is never rejected, so the type can be Stream<T>
        const stream: Stream<T> = Stream.fromPromise(df.promise);
        return {stream, setter};
    }

    // note - when generate() ends with error,
    // the stream emits the error as a value and then finishes
    // note - condition is for CONTINUING
    // the last value will always NOT satisfy the condition
    static generate<T>(
        initial: T,
        generate: (state: T) => Promise<T>,
        condition: (state: T) => boolean
    ): Stream<T | Error> {
        return new Stream((update, finish) => {
            let disposed = false;
            const iterate = (state) => {
                let promise;
                try {
                    // catch error in generate, if it happens
                    promise = generate(state);
                } catch (error) {
                    if (disposed) {
                        // stop the iteration
                    } else {
                        update(formatError(error));
                        finish();
                    }
                    return;
                }
                promise.then((state) => {
                    if (disposed) {
                        // stop the iteration
                    } else {
                        update(state);
                        if (condition(state)) {
                            iterate(state);
                        } else {
                            finish();
                        }
                    }
                }, (error) => {
                    if (disposed) {
                        // stop the iteration
                    } else {
                        update(formatError(error));
                        finish();
                    }
                });
            };
            setTimeout(() => iterate(initial), 1);
            return () => { disposed = true; };
        });
    }

    static simple<T>(value: T): Stream<T> {
        const values: Emitter<T> = new Emitter();
        const finish: Emitter<void> = new Emitter();
        const stream = Stream.fromEmitterFinish(values, finish, () => {});
        setTimeout(() => {
            values.emit(value);
            setTimeout(() => {
                finish.emit();
            }, 1);
        }, 1);
        return stream;
    }

    static combineFlat<T>(streams: Array<Stream<T>>): Stream<T> {
        if (streams.length === 0) {
            return Stream.empty();
        }
        return new Stream((update, finish) => {
            const finished = new Set();
            streams.forEach((s, i) => {
                s.values.attach((v) => {
                    update(v);
                });
                s.finish.attach(() => {
                    finished.add(i);
                    if (finished.size >= streams.length) {
                        finish();
                    }
                });
            });
            return () => {
                streams.forEach((s) => s.dispose());
            };
        });
    }

    static filterError<T>(
        stream: Stream<Error | T>
    ): Stream<T> {
        return new Stream((update, finish) => {
            stream.values.attach((value) => {
                if (!(value instanceof Error)) {
                    update(value);
                }
            });
            stream.finish.attach(finish);
            return stream.dispose;
        });
    }

    disposed: boolean = false;

    constructor(controller: Controller<T>) {
        this.values = new Emitter();
        this.finish = new Emitter();
        const controllerDispose = controller(
            (value) => { this.values.emit(value); },
            () => { this.finish.emit(); }
        );
        this.dispose = () => {
            controllerDispose();
            this.values.destroy();
            this.finish.destroy();
            this.disposed = true;
        };
    }

    awaitFirst(): Promise<T> {
        return new Promise((resolve, reject) => {
            let onFinish = () => {};
            const onValue = (value) => {
                this.values.detach(onValue);
                this.finish.detach(onFinish);
                resolve(value);
            };
            onFinish = () => {
                this.values.detach(onValue);
                this.finish.detach(onFinish);
                reject(new Error('No first value.'));
            };
            this.values.attach(onValue);
            this.finish.attach(onFinish);
        });
    }

    awaitFinish(): Promise<void> {
        return new Promise((resolve) => {
            const onFinish = (finish) => {
                this.finish.detach(onFinish);
                resolve();
            };
            this.finish.attach(onFinish);
        });
    }

    map<U>(fn: (value: T) => U): Stream<U> {
        return new Stream((update, finish) => {
            this.values.attach((value) => { update(fn(value)); });
            this.finish.attach(finish);
            return this.dispose;
        });
    }

    // note: this DOES keep the order
    mapPromise<U>(fn: (value: T) => Promise<U>): Stream<U> {
        return new Stream((update, finish) => {
            let previous: Promise<any> = Promise.resolve();
            let disposed = false;
            this.values.attach((value) => {
                const previousNow = previous;
                previous = fn(value).then(u => {
                    previousNow.then(() => {
                        if (!disposed) {
                            update(u);
                        }
                    });
                });
            });
            this.finish.attach(() => {
                previous.then(() => finish());
            });
            return () => {
                disposed = true;
                this.dispose();
            };
        });
    }

    mapPromiseError<U>(fn: (value: T) => Promise<U>): Stream<U | Error> {
        return new Stream((update, finish) => {
            let previous: Promise<any> = Promise.resolve();
            let disposed = false;
            this.values.attach((value) => {
                const previousNow = previous;
                previous = fn(value).then(u => {
                    previousNow.then(() => {
                        if (!disposed) {
                            update(u);
                        }
                    });
                }, error => {
                    previousNow.then(() => {
                        if (!disposed) {
                            update(error);
                        }
                    });
                });
            });
            this.finish.attach(() => {
                previous.then(() => finish());
            });
            return () => {
                disposed = true;
                this.dispose();
            };
        });
    }

    filter(fn: (value: T) => boolean): Stream<T> {
        return new Stream((update, finish) => {
            this.values.attach((value) => {
                if (fn(value)) {
                    update(value);
                }
            });
            this.finish.attach(finish);
            return this.dispose;
        });
    }

    reduce<U>(fn: (previous: U, value: T) => U, initial: U): Promise<U> {
        return new Promise((resolve, reject) => {
            let state = initial;
            this.values.attach((value) => { state = fn(state, value); });
            this.finish.attach(() => { resolve(state); });
        });
    }
}

export class StreamWithEnding<UpdateT, EndingT> {
    stream: Stream<UpdateT>;
    ending: Promise<EndingT>; // ending never resolves before stream finishes
    dispose: (e: Error) => void;

    static fromStreamAndPromise(s: Stream<UpdateT>, ending: Promise<EndingT>): StreamWithEnding<UpdateT, EndingT> {
        // idiocy to make node.js happy to stop showing stupid errors
        ending.catch(() => {});
        const res: StreamWithEnding<UpdateT, EndingT> = new StreamWithEnding();
        res.stream = s;

        const def = deferred();
        res.dispose = (e: Error) => {
            def.reject(e);
            s.dispose();
        };
        s.awaitFinish().then(() => {
            def.resolve();
        });

        res.ending = def.promise.then(() => ending);
        return res;
    }

    static fromPromise<U, E>(p: Promise<StreamWithEnding<U, E>>): StreamWithEnding<U, E> {
        const res: StreamWithEnding<U, E> = new StreamWithEnding();
        // the rejection will come to the ending promise
        res.stream = Stream.filterError(Stream.fromPromise(p.then(s => s.stream)));
        res.ending = p.then(s => s.ending);
        let resolved = null;
        p.then(s => {
            resolved = s;
        });
        res.dispose = (e: Error) => {
            if (resolved != null) {
                resolved.dispose(e);
            }
        };
        return res;
    }
}
