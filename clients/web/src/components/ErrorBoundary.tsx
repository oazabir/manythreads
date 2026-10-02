import { Component, type ErrorInfo, type ReactNode } from 'react';
import { FullPageMessage } from './states';

type Props = { children: ReactNode; resetKey?: string };
type State = { error: Error | null; resetKey: string | undefined };

/** Last line of defence: a render error shows a page with a way back instead of a blank screen. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // navigating to another route clears a previous error
    if (props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('render error', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <FullPageMessage title="Something went wrong" tone="alert" detail={this.state.error.message}>
          <a className="btn primary" href="/">Back to manythreads</a>
          <button type="button" className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
        </FullPageMessage>
      );
    }
    return this.props.children;
  }
}
