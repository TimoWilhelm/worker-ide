import { Component, type ComponentType, type ReactNode } from 'react';

interface FallbackProperties {
	error: Error;
	resetErrorBoundary: () => void;
}

interface ErrorBoundaryProperties {
	children: ReactNode;
	fallback: ComponentType<FallbackProperties>;
}

interface ErrorBoundaryState {
	hasError: boolean;
	error: Error | undefined;
}
export class ErrorBoundary extends Component<ErrorBoundaryProperties, ErrorBoundaryState> {
	constructor(properties: ErrorBoundaryProperties) {
		super(properties);
		this.state = { hasError: false, error: undefined };
	}

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		console.error('ErrorBoundary caught error:', error, errorInfo);
	}

	resetErrorBoundary = () => {
		this.setState({ hasError: false, error: undefined });
	};

	render() {
		if (this.state.hasError && this.state.error) {
			const Fallback = this.props.fallback;
			return <Fallback error={this.state.error} resetErrorBoundary={this.resetErrorBoundary} />;
		}

		return this.props.children;
	}
}
