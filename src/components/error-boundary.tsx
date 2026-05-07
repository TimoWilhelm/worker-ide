import { Component, type ComponentType, type ReactNode } from 'react';

import { isDynamicImportFailure, isUpdateActivationReloadPending, recoverFromStaleAsset } from '@/lib/stale-asset-recovery';

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
	suppressFallback: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProperties, ErrorBoundaryState> {
	constructor(properties: ErrorBoundaryProperties) {
		super(properties);
		this.state = { hasError: false, error: undefined, suppressFallback: false };
	}

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		if (isDynamicImportFailure(error) && isUpdateActivationReloadPending()) {
			return { hasError: true, error: undefined, suppressFallback: true };
		}

		return { hasError: true, error, suppressFallback: false };
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		if (isDynamicImportFailure(error)) {
			recoverFromStaleAsset();
		}

		console.error('ErrorBoundary caught error:', error, errorInfo);
	}

	resetErrorBoundary = () => {
		this.setState({ hasError: false, error: undefined, suppressFallback: false });
	};

	render() {
		if (this.state.hasError && this.state.suppressFallback) {
			return;
		}

		if (this.state.hasError && this.state.error) {
			const Fallback = this.props.fallback;
			return <Fallback error={this.state.error} resetErrorBoundary={this.resetErrorBoundary} />;
		}

		return this.props.children;
	}
}
